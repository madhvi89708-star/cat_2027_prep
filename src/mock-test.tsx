import React, { useState, useEffect, useCallback, useRef } from "react";
import "katex/dist/katex.min.css";
import Latex from "react-latex-next";
import {
  Clock,
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  XCircle,
  AlertCircle,
  BookOpen,
  BarChart3,
  ArrowLeft,
  Flag,
  Eye,
  Lock,
  PlayCircle,
  ZoomIn,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { apiRequest } from "@/src/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

type SectionName = "VARC" | "DILR" | "Quantitative";

interface MockQuestion {
  id: string;
  section: SectionName;
  questionText: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  difficulty: "Easy" | "Medium" | "Hard";
  passageId?: string;
}

interface Passage {
  id: string;
  title: string;
  text: string;
}

interface MockTest {
  id: string;
  name: string;
  totalDurationMinutes: number;
  sectionDurationMinutes: number;
  questions: MockQuestion[];
  passages?: Passage[];
  publishedDate?: string;
  studentsAttempted?: number;
}

interface SectionResult {
  section: SectionName;
  correctAnswers: number;
  wrongAnswers: number;
  skippedQuestions: number;
  score: number;
  scaledScore: number;
  timeSpent: number;
}

interface MockResult {
  testId: string;
  totalScore: number;
  overallScaledScore: number;
  percentile: number;
  sectionResults: SectionResult[];
  studentAnswers: Record<string, string>;
  timeSpent: number;
  submittedAt?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SECTION_ORDER: SectionName[] = ["VARC", "DILR", "Quantitative"];

const SECTION_META: Record<SectionName, {
  label: string;
  short: string;
  color: string;
  lightColor: string;
  textColor: string;
  borderColor: string;
}> = {
  VARC: {
    label: "Verbal Ability & Reading Comprehension",
    short: "VARC",
    color: "bg-violet-500",
    lightColor: "bg-violet-50",
    textColor: "text-violet-700",
    borderColor: "border-violet-200",
  },
  DILR: {
    label: "Data Interpretation & Logical Reasoning",
    short: "DILR",
    color: "bg-blue-500",
    lightColor: "bg-blue-50",
    textColor: "text-blue-700",
    borderColor: "border-blue-200",
  },
  Quantitative: {
    label: "Quantitative Ability",
    short: "QA",
    color: "bg-emerald-500",
    lightColor: "bg-emerald-50",
    textColor: "text-emerald-700",
    borderColor: "border-emerald-200",
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function calcScaledScore(correct: number, wrong: number, total: number) {
  if (total === 0) return 0;
  const raw = correct * 3 - wrong;
  const maxRaw = total * 3;
  return Math.max(0, Math.round((raw / maxRaw) * 100));
}

function estimatePercentile(compositeScaled: number): number {
  const percentileTable: [number, number][] = [
    [0, 0],
    [30, 70],
    [40, 80],
    [50, 88],
    [60, 93],
    [70, 96],
    [80, 98],
    [85, 98.7],
    [90, 99.2],
    [100, 99.6],
    [110, 99.85],
    [120, 99.95],
    [130, 99.98],
    [140, 99.99],
    [160, 100],
  ];

  if (compositeScaled <= 0) return 0;
  if (compositeScaled >= 160) return 99.99;

  for (let i = 0; i < percentileTable.length - 1; i++) {
    const [score1, pct1] = percentileTable[i];
    const [score2, pct2] = percentileTable[i + 1];
    if (compositeScaled >= score1 && compositeScaled <= score2) {
      const ratio = (compositeScaled - score1) / (score2 - score1);
      return Math.round((pct1 + ratio * (pct2 - pct1)) * 100) / 100;
    }
  }

  return 99.99;
}

// ─── Image URL Detection ───────────────────────────────────────────────────────
// Detects common image URL patterns and [image: url] / ![alt](url) markdown syntax

const IMAGE_URL_REGEX = /(?:!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)|\[image:\s*(https?:\/\/[^\]]+)\]|(https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?[^\s]*)?(?=#|\s|$)))/gi;

type PassageSegment =
  | { type: "text"; content: string }
  | { type: "image"; url: string; alt?: string };

/**
 * Parses a passage text string into an array of text and image segments.
 * Handles:
 *   - Bare image URLs:  https://example.com/chart.png
 *   - Markdown images:  ![alt text](https://example.com/chart.png)
 *   - Tagged images:    [image: https://example.com/chart.png]
 */
function parsePassageSegments(text: string): PassageSegment[] {
  const normalized = text.replace(/\\n/g, "\n");
  const segments: PassageSegment[] = [];
  let lastIndex = 0;

  // Reset regex state
  IMAGE_URL_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = IMAGE_URL_REGEX.exec(normalized)) !== null) {
    const [fullMatch, mdAlt, mdUrl, tagUrl, bareUrl] = match;
    const url = mdUrl || tagUrl || bareUrl;
    const alt = mdAlt || undefined;

    // Push any text before this match
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: normalized.slice(lastIndex, match.index) });
    }

    segments.push({ type: "image", url: url.trim(), alt });
    lastIndex = match.index + fullMatch.length;
  }

  // Push remaining text
  if (lastIndex < normalized.length) {
    segments.push({ type: "text", content: normalized.slice(lastIndex) });
  }

  return segments;
}

// ─── Passage Image Lightbox ────────────────────────────────────────────────────

function PassageImage({ url, alt }: { url: string; alt?: string }) {
  const [lightbox, setLightbox] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  if (error) {
    return (
      <div className="my-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600">
        <span>⚠️ Image failed to load:</span>
        <a href={url} target="_blank" rel="noopener noreferrer" className="underline truncate max-w-[200px]">{url}</a>
      </div>
    );
  }

  return (
    <>
      <div className="my-3 relative group">
        {!loaded && (
          <div className="h-24 rounded-lg bg-secondary/40 animate-pulse flex items-center justify-center text-xs text-muted-foreground">
            Loading image…
          </div>
        )}
        <img
          src={url}
          alt={alt || "Passage image"}
          className={`max-w-full rounded-lg border border-border shadow-sm cursor-zoom-in transition-opacity ${loaded ? "opacity-100" : "opacity-0 absolute inset-0"}`}
          style={{ maxHeight: "300px", objectFit: "contain" }}
          onLoad={() => setLoaded(true)}
          onError={() => { setLoaded(true); setError(true); }}
          onClick={() => setLightbox(true)}
        />
        {loaded && !error && (
          <button
            onClick={() => setLightbox(true)}
            className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity"
            title="View full size"
          >
            <ZoomIn size={14} />
          </button>
        )}
        {alt && loaded && !error && (
          <p className="text-[11px] text-center text-muted-foreground mt-1 italic">{alt}</p>
        )}
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setLightbox(false)}
        >
          <button
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20"
            onClick={() => setLightbox(false)}
          >
            <X size={20} />
          </button>
          <img
            src={url}
            alt={alt || "Passage image"}
            className="max-w-full max-h-[90vh] rounded-lg shadow-2xl object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

// ─── Passage Renderer ──────────────────────────────────────────────────────────

function PassageContent({ text }: { text: string }) {
  const segments = parsePassageSegments(text);

  return (
    <div className="space-y-1">
      {segments.map((seg, i) => {
        if (seg.type === "image") {
          return <PassageImage key={i} url={seg.url} alt={seg.alt} />;
        }
        // Split text segment into paragraphs
        return (
          <div key={i}>
            {seg.content
              .split("\n\n")
              .map((para, j) => para.trim())
              .filter(Boolean)
              .map((para, j) => (
                <p key={j} className="mb-2 last:mb-0">{para}</p>
              ))}
          </div>
        );
      })}
    </div>
  );
}

// ─── Status dot for question palette ───────────────────────────────────────────

function StatusDot({
  answered,
  flagged,
  current,
  idx,
  onClick,
}: {
  answered: boolean;
  flagged: boolean;
  current: boolean;
  idx: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-9 h-9 rounded-lg text-xs font-bold transition-all flex items-center justify-center relative
        ${current ? "ring-2 ring-offset-1 ring-primary scale-110" : ""}
        ${answered ? "bg-blue-500 text-white" : "bg-secondary text-muted-foreground hover:bg-secondary/80"}
      `}
    >
      {idx + 1}
      {flagged && <span className="absolute -top-1 -right-1 w-3 h-3 bg-orange-400 rounded-full" />}
    </button>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function MockTest({ user }: { user: any }) {
  const [view, setView] = useState<
    "list" | "instructions" | "section-intro" | "test" | "section-break" | "result"
  >("list");
  const [availableTests, setAvailableTests] = useState<MockTest[]>([]);
  const [attempts, setAttempts] = useState<Record<string, MockResult>>({});
  const [selectedTest, setSelectedTest] = useState<MockTest | null>(null);
  const [loading, setLoading] = useState(true);
  const [testLoading, setTestLoading] = useState(false);

  const [sectionIdx, setSectionIdx] = useState(0);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [timeLeft, setTimeLeft] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult] = useState<MockResult | null>(null);
  const [activePassage, setActivePassage] = useState<Passage | null>(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [reviewSection, setReviewSection] = useState<SectionName | null>(null);

  const testStartRef = useRef<number>(0);

  useEffect(() => {
    loadTests();
  }, []);

  const loadTests = async () => {
    setLoading(true);
    try {
      const [tests, prevResults] = await Promise.all([
        apiRequest("/mock-tests"),
        apiRequest("/mock-results"),
      ]);
      setAvailableTests(tests || []);
      const map: Record<string, MockResult> = {};
      (prevResults || []).forEach((r: MockResult) => {
        map[r.testId] = r;
      });
      setAttempts(map);
    } catch (err: any) {
      toast.error("Failed to load mock tests");
    } finally {
      setLoading(false);
    }
  };

  const sectionQuestions = useCallback(
    (test: MockTest | null, section: SectionName) => {
      if (!test?.questions) return [];
      return test.questions.filter((q) => q.section === section);
    },
    []
  );

  useEffect(() => {
    if (view !== "test" || submitted) return;
    if (timeLeft <= 0) {
      handleSectionEnd();
      return;
    }
    const t = setInterval(() => setTimeLeft((p) => p - 1), 1000);
    return () => clearInterval(t);
  }, [view, submitted, timeLeft]);

  useEffect(() => {
    if (!selectedTest || view !== "test") return;
    const qs = sectionQuestions(selectedTest, SECTION_ORDER[sectionIdx]);
    const q = qs[currentIdx];
    if (q?.passageId && selectedTest.passages) {
      setActivePassage(selectedTest.passages.find((p) => p.id === q.passageId) || null);
    } else {
      setActivePassage(null);
    }
  }, [currentIdx, sectionIdx, selectedTest, view, sectionQuestions]);

  const startTest = async (test: MockTest) => {
    if (attempts[test.id]) {
      setTestLoading(true);
      try {
        const fullTest = await apiRequest(`/mock-test/${test.id}`);
        setSelectedTest(fullTest);
        setResult(attempts[test.id]);
        setAnswers(attempts[test.id].studentAnswers || {});
        setView("result");
      } catch {
        toast.error("Failed to load test for review");
      } finally {
        setTestLoading(false);
      }
      return;
    }

    setTestLoading(true);
    try {
      const fullTest = await apiRequest(`/mock-test/${test.id}`);
      if (!fullTest?.questions?.length) {
        toast.error("This mock test has no questions yet. Please check the sheet data.");
        return;
      }
      setSelectedTest(fullTest);
      setView("instructions");
    } catch (err: any) {
      toast.error("Failed to load test questions. Check server connection.");
    } finally {
      setTestLoading(false);
    }
  };

  const beginSection = (idx: number) => {
    if (!selectedTest) return;
    const qs = sectionQuestions(selectedTest, SECTION_ORDER[idx]);
    if (!qs.length) {
      toast.error(`No questions found for ${SECTION_ORDER[idx]} section.`);
      return;
    }
    setSectionIdx(idx);
    setCurrentIdx(0);
    setFlagged(new Set());
    setTimeLeft((selectedTest.sectionDurationMinutes || 40) * 60);
    setSubmitted(false);
    setView("test");
  };

  const startWholeTest = () => {
    if (!selectedTest) return;
    setAnswers({});
    testStartRef.current = Date.now();
    setSectionIdx(0);
    beginSection(0);
  };

  const toggleFlag = useCallback((qId: string) => {
    setFlagged((prev) => {
      const next = new Set(prev);
      next.has(qId) ? next.delete(qId) : next.add(qId);
      return next;
    });
  }, []);

  const handleSectionEnd = useCallback(() => {
    if (submitted) return;
    setSubmitted(true);

    const isLastSection = sectionIdx === SECTION_ORDER.length - 1;
    if (isLastSection) {
      finalizeTest();
    } else {
      setView("section-break");
    }
  }, [submitted, sectionIdx]);

  const proceedToNextSection = () => {
    const nextIdx = sectionIdx + 1;
    beginSection(nextIdx);
  };

  const finalizeTest = useCallback(async () => {
    if (!selectedTest) return;

    const sectionResults: SectionResult[] = SECTION_ORDER.map((sec) => {
      const qs = sectionQuestions(selectedTest, sec);
      let correct = 0, wrong = 0, skipped = 0;
      qs.forEach((q) => {
        const ans = answers[q.id];
        if (!ans) skipped++;
        else if (ans === q.correctAnswer) correct++;
        else wrong++;
      });
      const score = correct * 3 - wrong;
      const scaledScore = calcScaledScore(correct, wrong, qs.length);
      return {
        section: sec,
        correctAnswers: correct,
        wrongAnswers: wrong,
        skippedQuestions: skipped,
        score,
        scaledScore,
        timeSpent: (selectedTest.sectionDurationMinutes || 40) * 60,
      };
    });

    const totalScore = sectionResults.reduce((s, r) => s + r.score, 0);
    const overallScaledScore = Math.round(
      sectionResults.reduce((s, r) => s + r.scaledScore, 0) / sectionResults.length * 3
    );
    const percentile = estimatePercentile(overallScaledScore);
    const timeSpent = Math.round((Date.now() - testStartRef.current) / 1000);

    const payload: MockResult = {
      testId: selectedTest.id,
      totalScore,
      overallScaledScore,
      percentile,
      sectionResults,
      studentAnswers: answers,
      timeSpent,
    };

    try {
      await apiRequest("/mock-results", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setResult(payload);
      setAttempts((prev) => ({ ...prev, [selectedTest.id]: payload }));
      toast.success("Mock test submitted!");
    } catch {
      toast.error("Failed to save result, showing local summary.");
      setResult(payload);
    } finally {
      setView("result");
    }
  }, [selectedTest, answers, sectionQuestions]);

  // ─── VIEWS ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // ── LIST ────────────────────────────────────────────────────────────────────
  if (view === "list") {
    return (
      <div className="space-y-8">
        <header>
          <h1 className="text-3xl font-bold tracking-tight">Mock Tests</h1>
          <p className="text-muted-foreground mt-1">
            CAT full-length mocks · VARC + DILR + QA · 120 min, real exam interface
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {SECTION_ORDER.map((sec) => {
            const meta = SECTION_META[sec];
            return (
              <div key={sec} className={`rounded-xl p-4 border ${meta.lightColor} ${meta.borderColor}`}>
                <div className="flex items-center gap-2 mb-2">
                  <div className={`w-2 h-2 rounded-full ${meta.color}`} />
                  <span className={`text-xs font-bold uppercase tracking-wider ${meta.textColor}`}>
                    {meta.short}
                  </span>
                </div>
                <p className="font-semibold text-sm">{meta.label}</p>
                <p className="text-xs text-muted-foreground mt-1">40 min · individually timed</p>
              </div>
            );
          })}
        </div>

        {availableTests.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center border border-dashed rounded-2xl bg-background">
            <BookOpen className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <h3 className="font-bold text-lg">No Mock Tests Available</h3>
            <p className="text-muted-foreground max-w-sm mt-1">
              Your admin hasn't published any full-length mock tests yet. Check back soon.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {availableTests.map((t) => {
              const attempted = attempts[t.id];
              return (
                <Card key={t.id} className="hover:shadow-md transition-all border-t-4 border-t-indigo-500">
                  <CardHeader className="pb-2">
                    <div className="flex justify-between items-start">
                      <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200 text-[10px] font-bold">
                        FULL MOCK
                      </Badge>
                      {attempted ? (
                        <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border-none text-[10px]">
                          Completed
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">
                          Pending
                        </Badge>
                      )}
                    </div>
                    <CardTitle className="text-base mt-2">{t.name}</CardTitle>
                    <div className="flex items-center justify-between text-xs mt-3 pt-3 border-t border-border">
                      <span className="text-muted-foreground flex items-center gap-1">
                        👥 Students Attempted
                      </span>
                      <span className="font-semibold text-emerald-600">
                        {(t.studentsAttempted || 0).toLocaleString()}+
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock size={12} /> {t.totalDurationMinutes || 120} min
                      </span>
                      <span className="flex items-center gap-1">
                        <BookOpen size={12} /> {t.questions?.length ?? "–"} Qs
                      </span>
                    </div>
                    {attempted && (
                      <div className="p-3 rounded-xl bg-indigo-50 border border-indigo-200">
                        <div className="flex gap-4 text-center">
                          <div className="flex-1">
                            <p className="text-[10px] font-bold uppercase text-muted-foreground">Score</p>
                            <p className="text-xl font-black text-indigo-700">{attempted.overallScaledScore}</p>
                          </div>
                          <div className="w-px bg-border" />
                          <div className="flex-1">
                            <p className="text-[10px] font-bold uppercase text-muted-foreground">%ile</p>
                            <p className="text-xl font-black text-green-600">{attempted.percentile}</p>
                          </div>
                          <div className="w-px bg-border" />
                          <div className="flex-1">
                            <p className="text-[10px] font-bold uppercase text-muted-foreground">Marks</p>
                            <p className="text-xl font-black">{attempted.totalScore}</p>
                          </div>
                        </div>
                      </div>
                    )}
                    <Button
                      className="w-full"
                      variant={attempted ? "outline" : "default"}
                      onClick={() => startTest(t)}
                      disabled={testLoading}
                    >
                      {testLoading && selectedTest?.id === t.id
                        ? "Loading..."
                        : attempted
                        ? "Review Attempt"
                        : "Start Mock Test"}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── INSTRUCTIONS ─────────────────────────────────────────────────────────────
  if (view === "instructions" && selectedTest) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Button variant="ghost" className="gap-2" onClick={() => setView("list")}>
          <ArrowLeft size={16} /> Back
        </Button>
        <Card className="border-2 border-indigo-200">
          <CardHeader className="bg-indigo-50 rounded-t-xl">
            <div className="text-xs font-bold uppercase tracking-widest text-indigo-700 mb-1">
              Full Length Mock
            </div>
            <CardTitle className="text-2xl">{selectedTest.name}</CardTitle>
            <div className="flex items-center justify-between text-xs mt-3 pt-3 border-t border-border">
              <span className="text-muted-foreground flex items-center gap-1">
                👥 Students Attempted
              </span>
              <span className="font-semibold text-emerald-600">
                {(selectedTest.studentsAttempted || 0).toLocaleString()}+
              </span>
            </div>
          </CardHeader>
          <CardContent className="pt-6 space-y-6">
            <div className="grid grid-cols-3 gap-4 text-center">
              {[
                ["Total Duration", `${selectedTest.totalDurationMinutes || 120} min`],
                ["Sections", "3"],
                ["Marking", "+3 / –1"],
              ].map(([label, val]) => (
                <div key={label} className="p-4 bg-secondary/30 rounded-xl">
                  <p className="text-2xl font-black">{val}</p>
                  <p className="text-xs text-muted-foreground font-bold uppercase mt-1">{label}</p>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-3">
              {SECTION_ORDER.map((sec) => {
                const meta = SECTION_META[sec];
                const count = sectionQuestions(selectedTest, sec).length;
                return (
                  <div key={sec} className={`p-3 rounded-xl border ${meta.lightColor} ${meta.borderColor} text-center`}>
                    <p className={`text-xs font-bold uppercase ${meta.textColor}`}>{meta.short}</p>
                    <p className="text-lg font-black mt-1">{count}</p>
                    <p className="text-[10px] text-muted-foreground">questions · {selectedTest.sectionDurationMinutes || 40} min</p>
                  </div>
                );
              })}
            </div>

            <div className="space-y-3">
              <h3 className="font-bold text-sm uppercase tracking-wide text-muted-foreground">Instructions</h3>
              {[
                "This mock has 3 sections, each individually timed. You cannot go back to a previous section once it ends.",
                "Each correct answer earns +3 marks. Each wrong answer deducts –1 mark. Unattempted questions carry 0 marks.",
                "Within a section, you can navigate freely between questions and flag any for review.",
                "When a section's timer hits zero, it auto-submits and the next section begins immediately.",
                "After the final section, you'll see your composite score, percentile estimate, and a full review.",
              ].map((rule, i) => (
                <div key={i} className="flex gap-3 text-sm">
                  <span className="w-5 h-5 shrink-0 rounded-full bg-indigo-500 text-white flex items-center justify-center text-[10px] font-bold mt-0.5">
                    {i + 1}
                  </span>
                  <p className="text-muted-foreground">{rule}</p>
                </div>
              ))}
            </div>

            <Button size="lg" className="w-full" onClick={startWholeTest}>
              Begin Mock Test · {selectedTest.totalDurationMinutes || 120} min
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── SECTION BREAK ─────────────────────────────────────────────────────────────
  if (view === "section-break" && selectedTest) {
    const justFinished = SECTION_ORDER[sectionIdx];
    const next = SECTION_ORDER[sectionIdx + 1];
    const nextMeta = SECTION_META[next];
    const justMeta = SECTION_META[justFinished];
    return (
      <div className="max-w-xl mx-auto py-12">
        <Card className={`border-2 ${nextMeta.borderColor}`}>
          <CardContent className="pt-8 pb-8 text-center space-y-6">
            <div className="flex justify-center gap-2">
              <CheckCircle2 className="text-green-500" size={28} />
            </div>
            <div>
              <h2 className="text-xl font-bold">{justMeta.short} Section Complete</h2>
              <p className="text-muted-foreground text-sm mt-1">
                Your answers for {justMeta.label} have been locked in.
              </p>
            </div>

            <div className={`p-5 rounded-2xl ${nextMeta.lightColor} border ${nextMeta.borderColor}`}>
              <p className={`text-xs font-bold uppercase ${nextMeta.textColor}`}>Up Next</p>
              <p className="text-lg font-black mt-1">{nextMeta.label}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {sectionQuestions(selectedTest, next).length} questions ·{" "}
                {selectedTest.sectionDurationMinutes || 40} minutes
              </p>
            </div>

            <Button size="lg" className="w-full gap-2" onClick={proceedToNextSection}>
              <PlayCircle size={18} /> Start {nextMeta.short} Section
            </Button>
            <p className="text-xs text-muted-foreground">
              You cannot return to {justMeta.short} once you proceed.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── TEST VIEW ─────────────────────────────────────────────────────────────────
  if (view === "test" && selectedTest) {
    const currentSection = SECTION_ORDER[sectionIdx];
    const questions = sectionQuestions(selectedTest, currentSection);
    if (!questions.length) {
      return (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <p className="text-muted-foreground">No questions found for this section.</p>
          <Button onClick={() => setView("list")}>Back to Tests</Button>
        </div>
      );
    }
    const currentQ = questions[currentIdx];
    if (!currentQ) return null;
    const meta = SECTION_META[currentSection];
    const answeredInSection = questions.filter((q) => answers[q.id]).length;
    const progress = (answeredInSection / questions.length) * 100;

    return (
      <div className="flex flex-col h-full min-h-screen">
        {/* Sticky Header */}
        <div className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b shadow-sm">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Badge className={`${meta.color} text-white border-none`}>{meta.short}</Badge>
              <span className="text-sm font-medium hidden sm:block">
                Section {sectionIdx + 1} of {SECTION_ORDER.length}
              </span>
              <span className="text-xs text-muted-foreground hidden md:block truncate max-w-[180px]">
                {selectedTest.name}
              </span>
            </div>
            <div className="flex items-center gap-4">
              <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-bold text-foreground">{answeredInSection}</span> / {questions.length} answered
              </div>
              <div
                className={`flex items-center gap-2 font-mono font-bold text-sm px-3 py-1.5 rounded-lg ${
                  timeLeft < 300 ? "bg-red-100 text-red-600 animate-pulse" : "bg-secondary text-foreground"
                }`}
              >
                <Clock size={14} />
                {formatTime(timeLeft)}
              </div>
              <Button size="sm" variant="destructive" onClick={handleSectionEnd}>
                {sectionIdx === SECTION_ORDER.length - 1 ? "Submit Test" : "Submit Section"}
              </Button>
            </div>
          </div>
          <Progress value={progress} className="h-1 rounded-none" />
          <div className="flex max-w-6xl mx-auto px-4 pb-1 gap-1">
            {SECTION_ORDER.map((sec, i) => (
              <div
                key={sec}
                className={`flex-1 h-1 rounded-full ${
                  i < sectionIdx
                    ? "bg-green-400"
                    : i === sectionIdx
                    ? SECTION_META[sec].color
                    : "bg-secondary"
                }`}
                title={sec}
              />
            ))}
          </div>
        </div>

        {/* Main layout */}
        <div className="flex-1 max-w-6xl mx-auto w-full px-4 py-6 grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-6">
          {/* Left: Passage + Question */}
          <div className="space-y-4">
            {activePassage && (
              <Card className="border-l-4 border-l-violet-400">
                <CardHeader className="pb-2">
                  <span className="text-xs font-bold uppercase text-muted-foreground tracking-wide">
                    Reading Passage · {activePassage.title}
                  </span>
                </CardHeader>
                <CardContent>
                  {/* ✅ Updated: renders both text paragraphs and images */}
                  <div className="text-sm leading-relaxed text-muted-foreground max-h-72 overflow-y-auto pr-2">
                    <PassageContent text={activePassage.text} />
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="shadow-md">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded ${meta.lightColor} ${meta.textColor}`}>
                      Q {currentIdx + 1} / {questions.length}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {currentQ.difficulty}
                    </Badge>
                  </div>
                  <button
                    onClick={() => toggleFlag(currentQ.id)}
                    className={`p-1.5 rounded-lg transition-colors ${
                      flagged.has(currentQ.id)
                        ? "text-orange-500 bg-orange-50"
                        : "text-muted-foreground hover:bg-secondary"
                    }`}
                    title="Flag for review"
                  >
                    <Flag size={16} />
                  </button>
                </div>
                <p className="text-base font-semibold leading-relaxed mt-3">
                  <Latex>{currentQ.questionText}</Latex>
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                <RadioGroup
                  value={answers[currentQ.id] || ""}
                  onValueChange={(val) => setAnswers((prev) => ({ ...prev, [currentQ.id]: val }))}
                >
                  {(Array.isArray(currentQ.options) ? currentQ.options : [])
                    .filter(Boolean)
                    .map((opt, idx) => (
                      <Label
                        key={opt}
                        className={`flex items-center gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
                          answers[currentQ.id] === opt
                            ? "border-primary bg-blue-50 ring-1 ring-primary"
                            : "border-border hover:border-primary/30 hover:bg-secondary/30"
                        }`}
                      >
                        <RadioGroupItem value={opt} id={`opt-${idx}`} className="sr-only" />
                        <div
                          className={`w-7 h-7 shrink-0 rounded-lg flex items-center justify-center font-bold text-xs border ${
                            answers[currentQ.id] === opt
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-secondary text-muted-foreground border-border"
                          }`}
                        >
                          {String.fromCharCode(65 + idx)}
                        </div>
                        <span className="text-sm"><Latex>{opt}</Latex></span>
                      </Label>
                    ))}
                </RadioGroup>
              </CardContent>
            </Card>

            <div className="flex justify-between items-center">
              <Button
                variant="outline"
                onClick={() => setCurrentIdx((p) => Math.max(0, p - 1))}
                disabled={currentIdx === 0}
                className="gap-1"
              >
                <ChevronLeft size={16} /> Previous
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  setAnswers((prev) => {
                    const n = { ...prev };
                    delete n[currentQ.id];
                    return n;
                  })
                }
                className="text-muted-foreground"
              >
                Clear
              </Button>
              <Button
                onClick={() => {
                  if (currentIdx < questions.length - 1) {
                    setCurrentIdx((p) => p + 1);
                  } else {
                    handleSectionEnd();
                  }
                }}
                className="gap-1"
              >
                {currentIdx < questions.length - 1 ? (
                  <>
                    Next <ChevronRight size={16} />
                  </>
                ) : sectionIdx === SECTION_ORDER.length - 1 ? (
                  "Finish & Submit Test"
                ) : (
                  "Finish Section"
                )}
              </Button>
            </div>
          </div>

          {/* Right: Question palette */}
          <div className="lg:sticky lg:top-[88px] self-start space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Question Palette</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-5 gap-1.5 mb-4">
                  {questions.map((q, idx) => (
                    <StatusDot
                      key={q.id}
                      idx={idx}
                      answered={!!answers[q.id]}
                      flagged={flagged.has(q.id)}
                      current={idx === currentIdx}
                      onClick={() => setCurrentIdx(idx)}
                    />
                  ))}
                </div>
                <div className="space-y-1.5 text-xs text-muted-foreground border-t pt-3">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded bg-blue-500" />
                    Answered ({answeredInSection})
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded bg-secondary border" />
                    Not answered ({questions.length - answeredInSection})
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded bg-secondary border relative">
                      <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-orange-400 rounded-full" />
                    </div>
                    Flagged ({flagged.size})
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className={`border ${meta.borderColor}`}>
              <CardContent className="pt-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Section</span>
                  <span className={`font-bold ${meta.textColor}`}>{meta.short}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Sections left</span>
                  <span className="font-bold">{SECTION_ORDER.length - sectionIdx}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Flagged</span>
                  <span className="font-bold text-orange-500">{flagged.size}</span>
                </div>
              </CardContent>
            </Card>

            <div className="flex items-center gap-2 text-xs text-muted-foreground p-3 bg-secondary/30 rounded-xl">
              <Lock size={14} />
              <span>Previous sections are locked once submitted.</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── RESULT VIEW ───────────────────────────────────────────────────────────────
  if (view === "result" && result && selectedTest) {
    if (reviewMode) {
      const section = reviewSection || SECTION_ORDER[0];
      const meta = SECTION_META[section];
      const questions = sectionQuestions(selectedTest, section);

      return (
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <Button variant="ghost" onClick={() => setReviewMode(false)} className="gap-1">
                <ArrowLeft size={16} /> Back to Results
              </Button>
              <span className="font-bold">{selectedTest.name} · Review</span>
            </div>
            <div className="flex gap-2">
              {SECTION_ORDER.map((sec) => (
                <Button
                  key={sec}
                  size="sm"
                  variant={sec === section ? "default" : "outline"}
                  onClick={() => setReviewSection(sec)}
                >
                  {SECTION_META[sec].short}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            {questions.map((q, idx) => {
              const studentAns = result.studentAnswers[q.id];
              const isCorrect = studentAns === q.correctAnswer;
              const isSkipped = !studentAns;

              // Find the passage for this question if any
              const passage = q.passageId && selectedTest.passages
                ? selectedTest.passages.find((p) => p.id === q.passageId)
                : null;

              return (
                <Card
                  key={q.id}
                  className={`border-l-4 ${
                    isCorrect ? "border-l-green-500" : isSkipped ? "border-l-yellow-400" : "border-l-red-500"
                  }`}
                >
                  <CardHeader className="pb-2">
                    <div className="flex justify-between items-center">
                      <div className="flex gap-2">
                        <Badge variant="outline" className={`${meta.lightColor} ${meta.textColor}`}>
                          {q.section}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {q.difficulty}
                        </Badge>
                      </div>
                      {isCorrect ? (
                        <span className="text-green-600 flex items-center gap-1 text-xs font-bold">
                          <CheckCircle2 size={14} /> Correct (+3)
                        </span>
                      ) : isSkipped ? (
                        <span className="text-yellow-600 flex items-center gap-1 text-xs font-bold">
                          <AlertCircle size={14} /> Skipped (0)
                        </span>
                      ) : (
                        <span className="text-red-600 flex items-center gap-1 text-xs font-bold">
                          <XCircle size={14} /> Wrong (–1)
                        </span>
                      )}
                    </div>

                    {/* ✅ Passage shown inline in review too */}
                    {passage && (
                      <div className="mt-3 p-3 rounded-lg bg-secondary/30 border border-border text-xs text-muted-foreground leading-relaxed">
                        <p className="text-[10px] font-bold uppercase mb-2 text-muted-foreground">
                          Passage · {passage.title}
                        </p>
                        <PassageContent text={passage.text} />
                      </div>
                    )}

                    <p className="font-semibold text-sm mt-2">
                      Q{idx + 1}. <Latex>{q.questionText}</Latex>
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid gap-1.5">
                      {(Array.isArray(q.options) ? q.options : []).filter(Boolean).map((opt) => (
                        <div
                          key={opt}
                          className={`px-3 py-2 rounded-lg text-sm border ${
                            opt === q.correctAnswer
                              ? "bg-green-50 border-green-200 text-green-800 font-medium"
                              : opt === studentAns
                              ? "bg-red-50 border-red-200 text-red-800"
                              : "bg-secondary/20 border-transparent"
                          }`}
                        >
                          <Latex>{opt}</Latex>
                        </div>
                      ))}
                    </div>
                    {q.explanation && (
                      <div className="bg-secondary/30 p-3 rounded-lg text-sm">
                        <p className="font-bold text-xs uppercase mb-1">Explanation</p>
                        <p className="text-muted-foreground"><Latex>{q.explanation}</Latex></p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      );
    }

    // Summary screen
    return (
      <div className="max-w-3xl mx-auto space-y-8">
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={() => setView("list")} className="gap-1">
            <ArrowLeft size={16} /> All Tests
          </Button>
        </div>

        <Card className="border-2 border-indigo-200 overflow-hidden">
          <div className="bg-gradient-to-r from-indigo-500 to-violet-500 px-6 py-5 text-white">
            <p className="text-sm font-bold uppercase tracking-widest opacity-80">Full Length Mock Result</p>
            <h2 className="text-2xl font-black mt-1">{selectedTest.name}</h2>
            <div className="flex items-center justify-between text-xs mt-3 pt-3 border-t border-white/20">
              <span className="opacity-80 flex items-center gap-1">👥 Students Attempted</span>
              <span className="font-semibold">{(selectedTest.studentsAttempted || 0).toLocaleString()}+</span>
            </div>
          </div>
          <CardContent className="pt-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
              {[
                { label: "Composite Score", val: result.overallScaledScore, color: "text-indigo-700", big: true },
                { label: "Est. Percentile", val: result.percentile, color: "text-green-600", big: true },
                { label: "Total Raw Marks", val: result.totalScore, color: "text-foreground" },
                {
                  label: "Time Taken",
                  val: `${Math.floor(result.timeSpent / 60)}m`,
                  color: "text-foreground",
                },
              ].map(({ label, val, color, big }) => (
                <div key={label} className="p-4 bg-secondary/20 rounded-xl">
                  <p className="text-xs font-bold uppercase text-muted-foreground mb-1">{label}</p>
                  <p className={`font-black ${big ? "text-4xl" : "text-2xl"} ${color}`}>{val}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {result.sectionResults.map((sr) => {
            const meta = SECTION_META[sr.section];
            return (
              <Card key={sr.section} className={`border-t-4 ${meta.color.replace("bg-", "border-t-")}`}>
                <CardHeader className="pb-2">
                  <Badge variant="outline" className={`${meta.lightColor} ${meta.textColor} w-fit`}>
                    {meta.short}
                  </Badge>
                  <CardTitle className="text-sm mt-1">{meta.label}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Scaled Score</span>
                    <span className={`font-bold ${meta.textColor}`}>{sr.scaledScore}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Correct</span>
                    <span className="font-bold text-green-600">{sr.correctAnswers}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Wrong</span>
                    <span className="font-bold text-red-600">{sr.wrongAnswers}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Skipped</span>
                    <span className="font-bold text-yellow-600">{sr.skippedQuestions}</span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full mt-2 gap-1"
                    onClick={() => {
                      setReviewSection(sr.section);
                      setReviewMode(true);
                    }}
                  >
                    <Eye size={14} /> Review {meta.short}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <Button className="w-full gap-2" onClick={() => setView("list")}>
          <BarChart3 size={16} /> Back to Mock Tests
        </Button>
      </div>
    );
  }

  return null;
}
