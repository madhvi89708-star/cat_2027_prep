import React, { useState, useEffect, useCallback, useMemo } from "react";
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
  ZoomIn,
  X,
  CalendarDays,
  Lock,
  ArrowUpDown,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { apiRequest } from "@/src/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────
// Same question/passage shape as sectional-test.tsx (LaTeX, TITA, image-bearing
// passages) so the same backend data + rendering works unchanged here. A Daily
// Test is a single mixed-section paper published for a specific calendar date
// (one test per day) rather than a single-section paper.

interface DailyQuestion {
  id: string;
  section: "VARC" | "DILR" | "Quantitative" | "General";
  questionText: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  difficulty: "Easy" | "Medium" | "Hard";
  passageId?: string; // for RC passages
  questionType?: "MCQ" | "TITA"; // optional explicit flag; falls back to options.length
}

interface Passage {
  id: string;
  title: string;
  text: string;
}

interface DailyTest {
  id: string;
  testDate: string; // ISO date string, e.g. "2026-09-01" — one test per day
  durationMinutes: number;
  questions: DailyQuestion[];
  passages?: Passage[];
}

interface DailyResult {
  testId: string;
  testDate: string;
  totalScore: number;
  correctAnswers: number;
  wrongAnswers: number;
  skippedQuestions: number;
  timeSpent: number;
  studentAnswers: Record<string, string>;
  scaledScore: number; // CAT-style scaled score (0-100)
  sectionScores?: Record<string, number>;
}

type DailyStatus = "completed" | "pending" | "today" | "upcoming";
type SortMode = "date-desc" | "date-asc";
type StatusFilter = "all" | DailyStatus;

const ACCENT = {
  color: "bg-orange-500",
  lightColor: "bg-orange-50",
  textColor: "text-orange-700",
  borderColor: "border-orange-200",
};

const SECTION_TAG: Record<string, { label: string; textColor: string; lightColor: string }> = {
  VARC: { label: "VARC", textColor: "text-violet-700", lightColor: "bg-violet-50" },
  DILR: { label: "DILR", textColor: "text-blue-700", lightColor: "bg-blue-50" },
  Quantitative: { label: "QA", textColor: "text-emerald-700", lightColor: "bg-emerald-50" },
  General: { label: "General", textColor: "text-slate-700", lightColor: "bg-slate-100" },
};

const STATUS_META: Record<DailyStatus, { label: string; badgeClass: string; dotClass: string }> = {
  completed: { label: "Completed", badgeClass: "bg-green-100 text-green-700 border-none", dotClass: "bg-green-500" },
  today: { label: "Today", badgeClass: "bg-orange-100 text-orange-700 border-none", dotClass: "bg-orange-500" },
  pending: { label: "Pending", badgeClass: "bg-red-100 text-red-700 border-none", dotClass: "bg-red-500" },
  upcoming: { label: "Upcoming", badgeClass: "bg-slate-100 text-slate-500 border-none", dotClass: "bg-slate-400" },
};

// ─── Helpers (shared with sectional-test.tsx) ─────────────────────────────────

function MultiParagraphLatex({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  const normalized = text.replace(/\\n/g, "\n");
  const paras = normalized.split(/\n\n+/);
  return (
    <>
      {paras.map((para, i) => (
        <p key={i} className={i > 0 ? `mt-2 ${className || ""}` : className}>
          {para.split("\n").map((line, j, arr) => (
            <React.Fragment key={j}>
              <Latex>{line}</Latex>
              {j < arr.length - 1 && <br />}
            </React.Fragment>
          ))}
        </p>
      ))}
    </>
  );
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function calcScaledScore(correct: number, wrong: number, total: number) {
  // CAT-style: +3 correct, -1 wrong; scaled to 0–100
  const raw = correct * 3 - wrong;
  const maxRaw = total * 3;
  return Math.max(0, Math.round((raw / maxRaw) * 100));
}

function isTitaQuestion(q: DailyQuestion) {
  if (q.questionType) return q.questionType === "TITA";
  return !Array.isArray(q.options) || q.options.filter(Boolean).length === 0;
}

function normalizeTitaAnswer(val: string) {
  return (val || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isTitaCorrect(studentAns: string, correctAns: string) {
  if (!studentAns) return false;
  const a = normalizeTitaAnswer(studentAns);
  const b = normalizeTitaAnswer(correctAns);
  if (a === b) return true;
  const numA = Number(a);
  const numB = Number(b);
  if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
    return numA === numB;
  }
  return false;
}

const IMAGE_URL_REGEX = /(?:!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)|\[image:\s*(https?:\/\/[^\]]+)\]|(https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?[^\s]*)?(?=#|\s|$)))/gi;

type PassageSegment =
  | { type: "text"; content: string }
  | { type: "image"; url: string; alt?: string };

function parsePassageSegments(text: string): PassageSegment[] {
  const normalized = text.replace(/\\n/g, "\n");
  const segments: PassageSegment[] = [];
  let lastIndex = 0;

  IMAGE_URL_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = IMAGE_URL_REGEX.exec(normalized)) !== null) {
    const [fullMatch, mdAlt, mdUrl, tagUrl, bareUrl] = match;
    const url = mdUrl || tagUrl || bareUrl;
    const alt = mdAlt || undefined;

    if (match.index > lastIndex) {
      segments.push({ type: "text", content: normalized.slice(lastIndex, match.index) });
    }

    segments.push({ type: "image", url: url.trim(), alt });
    lastIndex = match.index + fullMatch.length;
  }

  if (lastIndex < normalized.length) {
    segments.push({ type: "text", content: normalized.slice(lastIndex) });
  }

  return segments;
}

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

function PassageContent({ text }: { text: string }) {
  const segments = parsePassageSegments(text);

  return (
    <div className="space-y-1">
      {segments.map((seg, i) => {
        if (seg.type === "image") {
          return <PassageImage key={i} url={seg.url} alt={seg.alt} />;
        }
        return (
          <div key={i}>
            {seg.content
              .split("\n\n")
              .map((para) => para.trim())
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
        ${answered ? "bg-orange-500 text-white" : "bg-secondary text-muted-foreground hover:bg-secondary/80"}
      `}
    >
      {idx + 1}
      {flagged && (
        <span className="absolute -top-1 -right-1 w-3 h-3 bg-orange-400 rounded-full" />
      )}
    </button>
  );
}

// ─── Date / status helpers ──────────────────────────────────────────────────

function startOfDay(d: Date) {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function getDailyStatus(testDate: string, attempted: boolean): DailyStatus {
  if (attempted) return "completed";
  const day = startOfDay(new Date(testDate));
  const today = startOfDay(new Date());
  if (day.getTime() > today.getTime()) return "upcoming";
  if (day.getTime() < today.getTime()) return "pending";
  return "today";
}

function formatDayLabel(dateStr: string) {
  const d = new Date(dateStr);
  return {
    weekday: d.toLocaleDateString(undefined, { weekday: "short" }),
    day: d.toLocaleDateString(undefined, { day: "2-digit" }),
    month: d.toLocaleDateString(undefined, { month: "short" }),
    full: d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
  };
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DailyPractice({ user }: { user: any }) {
  const [view, setView] = useState<"list" | "instructions" | "test" | "result">("list");
  const [availableTests, setAvailableTests] = useState<DailyTest[]>([]);
  const [attempts, setAttempts] = useState<Record<string, DailyResult>>({});
  const [selectedTest, setSelectedTest] = useState<DailyTest | null>(null);
  const [loading, setLoading] = useState(true);
  const [testLoading, setTestLoading] = useState(false);

  // Sorting / filtering (list view)
  const [sortMode, setSortMode] = useState<SortMode>("date-desc");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Test state
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [titaDraft, setTitaDraft] = useState("");
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [timeLeft, setTimeLeft] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult] = useState<DailyResult | null>(null);
  const [activePassage, setActivePassage] = useState<Passage | null>(null);
  const [reviewMode, setReviewMode] = useState(false);

  // ── Load tests ──────────────────────────────────────────────────────────────
  useEffect(() => {
    loadTests();
  }, []);

  const loadTests = async () => {
    setLoading(true);
    try {
      const [tests, prevResults] = await Promise.all([
        apiRequest("/daily-tests"),
        apiRequest("/performance"),
      ]);
      setAvailableTests(tests || []);
      const map: Record<string, DailyResult> = {};
      (prevResults || []).forEach((r: DailyResult) => {
        map[r.testId] = r;
      });
      setAttempts(map);
    } catch (err: any) {
      toast.error("Failed to load daily tests");
    } finally {
      setLoading(false);
    }
  };

  // ── Timer ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (view !== "test" || submitted || timeLeft <= 0) return;
    const t = setInterval(() => setTimeLeft((p) => p - 1), 1000);
    return () => clearInterval(t);
  }, [view, submitted, timeLeft]);

  useEffect(() => {
    if (view === "test" && !submitted && timeLeft === 0) {
      handleSubmit();
    }
  }, [timeLeft]);

  // ── Passage for current question ─────────────────────────────────────────
  useEffect(() => {
    if (!selectedTest || view !== "test") return;
    const q = selectedTest.questions[currentIdx];
    if (q?.passageId && selectedTest.passages) {
      setActivePassage(
        selectedTest.passages.find((p) => p.id === q.passageId) || null
      );
    } else {
      setActivePassage(null);
    }
  }, [currentIdx, selectedTest, view]);

  // Sync the local TITA input buffer whenever the current question changes
  useEffect(() => {
    if (!selectedTest || view !== "test") return;
    const q = selectedTest.questions[currentIdx];
    if (q && isTitaQuestion(q)) {
      setTitaDraft(answers[q.id] || "");
    }
  }, [currentIdx, selectedTest, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sorted + filtered list ────────────────────────────────────────────────
  const attemptedIds = attempts;

  const decoratedTests = useMemo(() => {
    return availableTests.map((t) => ({
      test: t,
      status: getDailyStatus(t.testDate, !!attemptedIds[t.id]),
    }));
  }, [availableTests, attemptedIds]);

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { all: decoratedTests.length, completed: 0, pending: 0, today: 0, upcoming: 0 };
    decoratedTests.forEach(({ status }) => { counts[status]++; });
    return counts;
  }, [decoratedTests]);

  const visibleTests = useMemo(() => {
    let list = decoratedTests;
    if (statusFilter !== "all") {
      list = list.filter((d) => d.status === statusFilter);
    }
    const sorted = [...list].sort((a, b) => {
      const diff = new Date(a.test.testDate).getTime() - new Date(b.test.testDate).getTime();
      return sortMode === "date-asc" ? diff : -diff;
    });
    return sorted;
  }, [decoratedTests, statusFilter, sortMode]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const startTest = async (test: DailyTest, status: DailyStatus) => {
    if (status === "upcoming") {
      toast.info("This daily test unlocks on its scheduled date.");
      return;
    }

    if (attempts[test.id]) {
      setTestLoading(true);
      try {
        const fullTest = await apiRequest(`/daily-test/${test.id}`);
        setSelectedTest(fullTest);
        setResult(attempts[test.id]);
        setAnswers(attempts[test.id].studentAnswers || {});
        setView("result");
      } catch {
        toast.error("Failed to load test");
      } finally {
        setTestLoading(false);
      }
      return;
    }

    setTestLoading(true);
    try {
      const fullTest = await apiRequest(`/daily-test/${test.id}`);
      if (!fullTest?.questions?.length) {
        toast.error("This test has no questions yet. Please check back soon.");
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

  const beginTest = () => {
    if (!selectedTest) return;
    const questions = selectedTest.questions;
    if (!questions?.length) {
      toast.error("No questions found in this test.");
      return;
    }
    setCurrentIdx(0);
    setAnswers({});
    setTitaDraft("");
    setFlagged(new Set());
    setTimeLeft((selectedTest.durationMinutes || 40) * 60);
    setSubmitted(false);
    setResult(null);
    setReviewMode(false);
    setView("test");
  };

  const toggleFlag = useCallback((qId: string) => {
    setFlagged((prev) => {
      const next = new Set(prev);
      next.has(qId) ? next.delete(qId) : next.add(qId);
      return next;
    });
  }, []);

  const commitTitaAnswer = useCallback((qId: string, val: string) => {
    setAnswers((prev) => {
      const next = { ...prev };
      if (val.trim() === "") {
        delete next[qId];
      } else {
        next[qId] = val;
      }
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!selectedTest || submitted) return;

    const currentQ = selectedTest.questions[currentIdx];
    let finalAnswers = answers;
    if (currentQ && isTitaQuestion(currentQ)) {
      finalAnswers = { ...answers };
      if (titaDraft.trim() === "") {
        delete finalAnswers[currentQ.id];
      } else {
        finalAnswers[currentQ.id] = titaDraft;
      }
    }

    setSubmitted(true);

    let correct = 0,
      wrong = 0,
      skipped = 0;
    const sectionScores: Record<string, number> = { Quantitative: 0, DILR: 0, VARC: 0, General: 0 };

    selectedTest.questions.forEach((q) => {
      const ans = finalAnswers[q.id];
      if (!ans) {
        skipped++;
      } else if (isTitaQuestion(q)) {
        if (isTitaCorrect(ans, q.correctAnswer)) {
          correct++;
          if (sectionScores[q.section] !== undefined) sectionScores[q.section]++;
        } else wrong++;
      } else if (ans === q.correctAnswer) {
        correct++;
        if (sectionScores[q.section] !== undefined) sectionScores[q.section]++;
      } else {
        wrong++;
      }
    });

    const total = selectedTest.questions.length;
    const scaledScore = calcScaledScore(correct, wrong, total);
    const totalScore = Math.round((correct / total) * 100);
    const timeSpent = (selectedTest.durationMinutes || 40) * 60 - timeLeft;

    const payload: DailyResult = {
      testId: selectedTest.id,
      testDate: selectedTest.testDate,
      totalScore,
      correctAnswers: correct,
      wrongAnswers: wrong,
      skippedQuestions: skipped,
      timeSpent,
      studentAnswers: finalAnswers,
      scaledScore,
      sectionScores,
    };

    try {
      await apiRequest("/test-results", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setResult(payload);
      setAnswers(finalAnswers);
      setAttempts((prev) => ({ ...prev, [selectedTest.id]: payload }));
      setView("result");
      toast.success("Daily test submitted!");
    } catch (err: any) {
      toast.error("Failed to save result");
      setResult(payload);
      setAnswers(finalAnswers);
      setView("result");
    }
  }, [selectedTest, submitted, answers, timeLeft, currentIdx, titaDraft]);

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
    const FILTERS: { key: StatusFilter; label: string }[] = [
      { key: "all", label: "All" },
      { key: "today", label: "Today" },
      { key: "pending", label: "Pending" },
      { key: "completed", label: "Completed" },
      { key: "upcoming", label: "Upcoming" },
    ];

    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-3xl font-bold tracking-tight">Daily Practice</h1>
          <p className="text-muted-foreground mt-1">
            One CAT-pattern mixed test every day · Track your streak
          </p>
        </header>

        {/* Sort + filter controls */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setStatusFilter(f.key)}
                className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors flex items-center gap-1.5
                  ${statusFilter === f.key
                    ? `${ACCENT.color} text-white border-transparent`
                    : "bg-background text-muted-foreground border-border hover:bg-secondary/50"}
                `}
              >
                {f.label}
                <span className={`text-[10px] px-1.5 rounded-full ${statusFilter === f.key ? "bg-white/20" : "bg-secondary"}`}>
                  {statusCounts[f.key]}
                </span>
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <SlidersHorizontal size={14} className="text-muted-foreground" />
            <button
              onClick={() => setSortMode((m) => (m === "date-desc" ? "date-asc" : "date-desc"))}
              className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full border bg-background hover:bg-secondary/50 transition-colors"
            >
              <ArrowUpDown size={12} />
              {sortMode === "date-desc" ? "Newest first" : "Oldest first"}
            </button>
          </div>
        </div>

        {visibleTests.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center border border-dashed rounded-2xl bg-background">
            <CalendarDays className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <h3 className="font-bold text-lg">No Daily Tests Here</h3>
            <p className="text-muted-foreground max-w-sm mt-1">
              {statusFilter === "all"
                ? "Your admin hasn't published any daily tests yet. Check back soon."
                : "Nothing matches this filter yet — try a different one."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {visibleTests.map(({ test, status }) => {
              const attempted = attempts[test.id];
              const label = formatDayLabel(test.testDate);
              const meta = STATUS_META[status];
              const locked = status === "upcoming";

              return (
                <Card
                  key={test.id}
                  className={`transition-all ${locked ? "opacity-70" : "hover:shadow-md"} border-l-4 ${
                    status === "completed" ? "border-l-green-500" :
                    status === "pending" ? "border-l-red-500" :
                    status === "today" ? "border-l-orange-500" : "border-l-slate-300"
                  }`}
                >
                  <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-4">
                    {/* Date block */}
                    <div className={`shrink-0 w-16 h-16 rounded-xl flex flex-col items-center justify-center border ${ACCENT.lightColor} ${ACCENT.borderColor}`}>
                      <span className="text-[10px] font-bold uppercase text-muted-foreground">{label.weekday}</span>
                      <span className={`text-xl font-black ${ACCENT.textColor}`}>{label.day}</span>
                      <span className="text-[10px] font-bold uppercase text-muted-foreground">{label.month}</span>
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-bold text-base truncate">Daily Practice · {label.full}</h3>
                        <Badge className={`text-[10px] font-bold ${meta.badgeClass}`}>{meta.label}</Badge>
                      </div>
                      <div className="flex gap-4 text-xs text-muted-foreground mt-1">
                        <span className="flex items-center gap-1">
                          <Clock size={12} /> {test.durationMinutes || 40} min
                        </span>
                        <span className="flex items-center gap-1">
                          <BookOpen size={12} /> {test.questions?.length ?? "–"} Qs
                        </span>
                      </div>

                      {attempted && (
                        <div className="flex gap-4 mt-2 text-xs">
                          <span className="font-bold text-orange-600">Score {attempted.scaledScore}</span>
                          <span className="font-bold text-green-600">{attempted.correctAnswers} correct</span>
                          <span className="font-bold text-muted-foreground">{attempted.totalScore}% acc.</span>
                        </div>
                      )}
                    </div>

                    {/* Action */}
                    <div className="shrink-0">
                      <Button
                        variant={attempted ? "outline" : locked ? "outline" : "default"}
                        disabled={testLoading || locked}
                        onClick={() => startTest(test, status)}
                        className="gap-2 w-full sm:w-auto"
                      >
                        {locked && <Lock size={14} />}
                        {testLoading && selectedTest?.id === test.id
                          ? "Loading..."
                          : attempted
                          ? "Review Attempt"
                          : locked
                          ? "Locked"
                          : status === "Pending"
                          ? "Attempt Now"
                          : "Start Test"}
                      </Button>
                    </div>
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
    const label = formatDayLabel(selectedTest.testDate);
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Button variant="ghost" className="gap-2" onClick={() => setView("list")}>
          <ArrowLeft size={16} /> Back
        </Button>
        <Card className={`border-2 ${ACCENT.borderColor}`}>
          <CardHeader className={`${ACCENT.lightColor} rounded-t-xl`}>
            <div className={`text-xs font-bold uppercase tracking-widest ${ACCENT.textColor} mb-1`}>
              Daily Practice
            </div>
            <CardTitle className="text-2xl">{label.full}</CardTitle>
          </CardHeader>
          <CardContent className="pt-6 space-y-6">
            <div className="grid grid-cols-3 gap-4 text-center">
              {[
                ["Questions", selectedTest.questions?.length],
                ["Duration", `${selectedTest.durationMinutes || 40} min`],
                ["Marking", "+3 / –1"],
              ].map(([label2, val]) => (
                <div key={label2} className="p-4 bg-secondary/30 rounded-xl">
                  <p className="text-2xl font-black">{val}</p>
                  <p className="text-xs text-muted-foreground font-bold uppercase mt-1">{label2}</p>
                </div>
              ))}
            </div>

            <div className="space-y-3">
              <h3 className="font-bold text-sm uppercase tracking-wide text-muted-foreground">Instructions</h3>
              {[
                "This is a timed daily test mixing VARC, DILR and Quant. The timer starts when you click Begin.",
                "Each correct answer earns +3 marks. Each wrong answer deducts –1 mark. Unattempted questions carry 0 marks.",
                "Some questions are Type-In-The-Answer (TITA) — there's no negative marking risk from guessing wrong, but you must type your answer in the box provided.",
                "You can navigate between questions freely and flag any question for later review.",
                "Once time is up, the test auto-submits. You can also submit early.",
                "Answers cannot be changed after submission.",
              ].map((rule, i) => (
                <div key={i} className="flex gap-3 text-sm">
                  <span className={`w-5 h-5 shrink-0 rounded-full ${ACCENT.color} text-white flex items-center justify-center text-[10px] font-bold mt-0.5`}>
                    {i + 1}
                  </span>
                  <p className="text-muted-foreground">{rule}</p>
                </div>
              ))}
            </div>

            <Button size="lg" className="w-full" onClick={beginTest}>
              Begin Daily Test · {selectedTest.durationMinutes || 40} min
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── TEST VIEW ────────────────────────────────────────────────────────────────
  if (view === "test" && selectedTest) {
    const questions = selectedTest.questions || [];
    if (!questions.length) {
      return (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <p className="text-muted-foreground">No questions found in this test.</p>
          <Button onClick={() => setView("list")}>Back to Daily Tests</Button>
        </div>
      );
    }
    const currentQ = questions[currentIdx];
    if (!currentQ) return null;
    const tag = SECTION_TAG[currentQ.section] || SECTION_TAG.General;
    const answeredCount = Object.keys(answers).length;
    const progress = (answeredCount / questions.length) * 100;
    const currentIsTita = isTitaQuestion(currentQ);

    const goToIdx = (newIdx: number) => {
      if (currentIsTita) {
        commitTitaAnswer(currentQ.id, titaDraft);
      }
      setCurrentIdx(newIdx);
    };

    return (
      <div className="flex flex-col h-full min-h-screen">
        {/* Sticky Header */}
        <div className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b shadow-sm">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Badge className={`${ACCENT.color} text-white border-none`}>Daily</Badge>
              <span className="text-sm font-medium hidden sm:block truncate max-w-[200px]">
                {formatDayLabel(selectedTest.testDate).full}
              </span>
            </div>
            <div className="flex items-center gap-4">
              <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-bold text-foreground">{answeredCount}</span> / {questions.length} answered
              </div>
              <div
                className={`flex items-center gap-2 font-mono font-bold text-sm px-3 py-1.5 rounded-lg ${
                  timeLeft < 300
                    ? "bg-red-100 text-red-600 animate-pulse"
                    : "bg-secondary text-foreground"
                }`}
              >
                <Clock size={14} />
                {formatTime(timeLeft)}
              </div>
              <Button size="sm" variant="destructive" onClick={handleSubmit}>
                Submit
              </Button>
            </div>
          </div>
          <Progress value={progress} className="h-1 rounded-none" />
        </div>

        {/* Main layout */}
        <div className="flex-1 max-w-6xl mx-auto w-full px-4 py-6 grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-6">
          {/* Left: Passage + Question */}
          <div className="space-y-4">
            {activePassage && (
              <Card className="border-l-4 border-l-violet-400">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase text-muted-foreground tracking-wide">
                      Reading Passage · {activePassage.title}
                    </span>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-sm leading-relaxed text-muted-foreground max-h-56 overflow-y-auto pr-2">
                    <PassageContent text={activePassage.text} />
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="shadow-md">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded ${tag.lightColor} ${tag.textColor}`}>
                      {tag.label}
                    </span>
                    <span className="text-xs font-bold px-2 py-0.5 rounded bg-secondary text-muted-foreground">
                      Q {currentIdx + 1} / {questions.length}
                    </span>
                    {currentIsTita && (
                      <Badge variant="outline" className="text-[10px] font-bold">
                        TITA
                      </Badge>
                    )}
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
                  <MultiParagraphLatex text={currentQ.questionText} />
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                {currentIsTita ? (
                  <div className="space-y-2">
                    <Label htmlFor="tita-input" className="text-xs font-bold uppercase text-muted-foreground">
                      Type your answer
                    </Label>
                    <Input
                      id="tita-input"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="Enter your answer here"
                      value={titaDraft}
                      onChange={(e) => setTitaDraft(e.target.value)}
                      onBlur={() => commitTitaAnswer(currentQ.id, titaDraft)}
                      className="text-base p-4 h-auto rounded-xl border-2 focus-visible:ring-1 focus-visible:ring-primary"
                    />
                    <p className="text-xs text-muted-foreground">
                      No options are given for this question — enter the numeric or text value you've calculated.
                    </p>
                  </div>
                ) : (
                  <RadioGroup
                    value={answers[currentQ.id] || ""}
                    onValueChange={(val) =>
                      setAnswers((prev) => ({ ...prev, [currentQ.id]: val }))
                    }
                  >
                    {(Array.isArray(currentQ.options) ? currentQ.options : []).filter(Boolean).map((opt, idx) => (
                      <Label
                        key={opt}
                        className={`flex items-center gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
                          answers[currentQ.id] === opt
                            ? `border-primary bg-orange-50 ring-1 ring-primary`
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
                )}
              </CardContent>
            </Card>

            {/* Navigation */}
            <div className="flex justify-between items-center">
              <Button
                variant="outline"
                onClick={() => goToIdx(Math.max(0, currentIdx - 1))}
                disabled={currentIdx === 0}
                className="gap-1"
              >
                <ChevronLeft size={16} /> Previous
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  if (currentIsTita) {
                    setTitaDraft("");
                  }
                  setAnswers((prev) => {
                    const n = { ...prev };
                    delete n[currentQ.id];
                    return n;
                  });
                }}
                className="text-muted-foreground"
              >
                Clear
              </Button>
              <Button
                onClick={() => {
                  if (currentIsTita) {
                    commitTitaAnswer(currentQ.id, titaDraft);
                  }
                  if (currentIdx < questions.length - 1) {
                    goToIdx(currentIdx + 1);
                  } else {
                    handleSubmit();
                  }
                }}
                className="gap-1"
              >
                {currentIdx < questions.length - 1 ? (
                  <>Next <ChevronRight size={16} /></>
                ) : (
                  "Finish & Submit"
                )}
              </Button>
            </div>
          </div>

          {/* Right: Question palette */}
          <div className="lg:sticky lg:top-[72px] self-start space-y-4">
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
                      onClick={() => goToIdx(idx)}
                    />
                  ))}
                </div>
                <div className="space-y-1.5 text-xs text-muted-foreground border-t pt-3">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded bg-orange-500" />
                    Answered ({answeredCount})
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded bg-secondary border" />
                    Not answered ({questions.length - answeredCount})
                  </div>
                  <div className="flex items-center gap-2 relative">
                    <div className="w-4 h-4 rounded bg-secondary border relative">
                      <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-orange-400 rounded-full" />
                    </div>
                    Flagged ({flagged.size})
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className={`border ${ACCENT.borderColor}`}>
              <CardContent className="pt-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Test</span>
                  <span className={`font-bold ${ACCENT.textColor}`}>Daily</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Marking</span>
                  <span className="font-bold">+3 / –1 / 0</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Flagged</span>
                  <span className="font-bold text-orange-500">{flagged.size}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  // ── RESULT VIEW ───────────────────────────────────────────────────────────────
  if (view === "result" && result && selectedTest) {
    const questions = selectedTest.questions;
    const label = formatDayLabel(selectedTest.testDate);

    if (reviewMode) {
      return (
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={() => setReviewMode(false)} className="gap-1">
              <ArrowLeft size={16} /> Back to Results
            </Button>
            <span className="font-bold">{label.full} · Review</span>
          </div>
          <div className="space-y-4">
            {questions.map((q, idx) => {
              const studentAns = result.studentAnswers[q.id];
              const qIsTita = isTitaQuestion(q);
              const isCorrect = qIsTita
                ? isTitaCorrect(studentAns, q.correctAnswer)
                : studentAns === q.correctAnswer;
              const isSkipped = !studentAns;
              const passage = q.passageId && selectedTest.passages
                ? selectedTest.passages.find((p) => p.id === q.passageId)
                : null;
              const tag = SECTION_TAG[q.section] || SECTION_TAG.General;
              return (
                <Card
                  key={q.id}
                  className={`border-l-4 ${
                    isCorrect
                      ? "border-l-green-500"
                      : isSkipped
                      ? "border-l-yellow-400"
                      : "border-l-red-500"
                  }`}
                >
                  <CardHeader className="pb-2">
                    <div className="flex justify-between items-center">
                      <div className="flex gap-2">
                        <Badge variant="outline" className={`text-[10px] ${tag.textColor}`}>{q.section}</Badge>
                        <Badge variant="outline" className="text-[10px]">{q.difficulty}</Badge>
                        {qIsTita && (
                          <Badge variant="outline" className="text-[10px] font-bold">TITA</Badge>
                        )}
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
                    <p className="font-semibold text-sm mt-2">
                      <span>Q{idx + 1}. </span>
                      <MultiParagraphLatex text={q.questionText} />
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {qIsTita ? (
                      <div className="grid gap-1.5 sm:grid-cols-2">
                        <div className="px-3 py-2 rounded-lg text-sm border bg-secondary/20 border-transparent">
                          <p className="text-[10px] font-bold uppercase text-muted-foreground mb-0.5">
                            Your answer
                          </p>
                          <p className={isSkipped ? "text-muted-foreground italic" : isCorrect ? "text-green-800 font-medium" : "text-red-800"}>
                            {isSkipped ? "Not attempted" : <Latex>{studentAns}</Latex>}
                          </p>
                        </div>
                        <div className="px-3 py-2 rounded-lg text-sm border bg-green-50 border-green-200">
                          <p className="text-[10px] font-bold uppercase text-muted-foreground mb-0.5">
                            Correct answer
                          </p>
                          <p className="text-green-800 font-medium">
                            <Latex>{q.correctAnswer}</Latex>
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className="grid gap-1.5">
                        {q.options.map((opt) => (
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
                            <Latex> {opt}</Latex>
                          </div>
                        ))}
                      </div>
                    )}
                    {q.explanation && (
                      <div className="bg-secondary/30 p-3 rounded-lg text-sm">
                        <p className="font-bold text-xs uppercase mb-1">Explanation</p>
                        <div className="text-muted-foreground">
                          <MultiParagraphLatex text={q.explanation} />
                        </div>
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

    const rawMarks = result.correctAnswers * 3 - result.wrongAnswers;
    const maxMarks = questions.length * 3;
    const attemptRate = Math.round(((result.correctAnswers + result.wrongAnswers) / questions.length) * 100);

    return (
      <div className="max-w-3xl mx-auto space-y-8">
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={() => setView("list")} className="gap-1">
            <ArrowLeft size={16} /> All Daily Tests
          </Button>
        </div>

        <Card className={`border-2 ${ACCENT.borderColor} overflow-hidden`}>
          <div className={`${ACCENT.color} px-6 py-5 text-white`}>
            <p className="text-sm font-bold uppercase tracking-widest opacity-80">Daily Practice</p>
            <h2 className="text-2xl font-black mt-1">{label.full}</h2>
          </div>
          <CardContent className="pt-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
              {[
                { label: "Scaled Score", val: result.scaledScore, color: ACCENT.textColor, big: true },
                { label: "Raw Marks", val: `${rawMarks}/${maxMarks}`, color: "text-foreground" },
                { label: "Accuracy", val: `${result.totalScore}%`, color: "text-foreground" },
                {
                  label: "Time Taken",
                  val: `${Math.floor(result.timeSpent / 60)}m ${result.timeSpent % 60}s`,
                  color: "text-foreground",
                },
              ].map(({ label: l, val, color, big }) => (
                <div key={l} className="p-4 bg-secondary/20 rounded-xl">
                  <p className="text-xs font-bold uppercase text-muted-foreground mb-1">{l}</p>
                  <p className={`font-black ${big ? "text-4xl" : "text-2xl"} ${color}`}>{val}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="p-5 text-center border-t-4 border-t-green-500">
            <CheckCircle2 className="mx-auto text-green-500 mb-2" size={24} />
            <p className="text-3xl font-black text-green-600">{result.correctAnswers}</p>
            <p className="text-xs font-bold uppercase text-muted-foreground mt-1">Correct</p>
            <p className="text-xs text-green-600 font-semibold mt-1">+{result.correctAnswers * 3} marks</p>
          </Card>
          <Card className="p-5 text-center border-t-4 border-t-red-500">
            <XCircle className="mx-auto text-red-500 mb-2" size={24} />
            <p className="text-3xl font-black text-red-600">{result.wrongAnswers}</p>
            <p className="text-xs font-bold uppercase text-muted-foreground mt-1">Wrong</p>
            <p className="text-xs text-red-600 font-semibold mt-1">–{result.wrongAnswers} marks</p>
          </Card>
          <Card className="p-5 text-center border-t-4 border-t-yellow-400">
            <AlertCircle className="mx-auto text-yellow-500 mb-2" size={24} />
            <p className="text-3xl font-black text-yellow-600">{result.skippedQuestions}</p>
            <p className="text-xs font-bold uppercase text-muted-foreground mt-1">Skipped</p>
            <p className="text-xs text-muted-foreground font-semibold mt-1">0 marks</p>
          </Card>
        </div>

        <Card className="p-5">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm font-bold">Attempt Rate</span>
            <span className="text-sm font-bold">{attemptRate}%</span>
          </div>
          <Progress value={attemptRate} className="h-2" />
          <p className="text-xs text-muted-foreground mt-2">
            You attempted {result.correctAnswers + result.wrongAnswers} of {questions.length} questions.
          </p>
        </Card>

        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1 gap-2"
            onClick={() => setReviewMode(true)}
          >
            <Eye size={16} /> Review All Questions
          </Button>
          <Button className="flex-1 gap-2" onClick={() => setView("list")}>
            <BarChart3 size={16} /> Back to Daily Tests
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
