import React, { useState, useEffect, useCallback } from "react";
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

interface SectionalQuestion {
  id: string;
  section: "VARC" | "DILR" | "Quantitative";
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

interface SectionalTest {
  id: string;
  name: string;
  section: "VARC" | "DILR" | "Quantitative";
  durationMinutes: number;
  questions: SectionalQuestion[];
  passages?: Passage[];
}

interface SectionalResult {
  testId: string;
  section: string;
  totalScore: number;
  correctAnswers: number;
  wrongAnswers: number;
  skippedQuestions: number;
  timeSpent: number;
  studentAnswers: Record<string, string>;
  scaledScore: number; // CAT-style scaled score (0-100)
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SECTION_META = {
  VARC: {
    label: "Verbal Ability & Reading Comprehension",
    short: "VARC",
    color: "bg-violet-500",
    lightColor: "bg-violet-50",
    textColor: "text-violet-700",
    borderColor: "border-violet-200",
    questions: 24,
    minutes: 40,
  },
  DILR: {
    label: "Data Interpretation & Logical Reasoning",
    short: "DILR",
    color: "bg-blue-500",
    lightColor: "bg-blue-50",
    textColor: "text-blue-700",
    borderColor: "border-blue-200",
    questions: 20,
    minutes: 40,
  },
  Quantitative: {
    label: "Quantitative Ability",
    short: "QA",
    color: "bg-emerald-500",
    lightColor: "bg-emerald-50",
    textColor: "text-emerald-700",
    borderColor: "border-emerald-200",
    questions: 22,
    minutes: 40,
  },
};

// ─── Helper ───────────────────────────────────────────────────────────────────

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

// A question is TITA (type-in-the-answer) if it's explicitly flagged as such,
// or if it simply has no options to choose from.
function isTitaQuestion(q: SectionalQuestion) {
  if (q.questionType) return q.questionType === "TITA";
  return !Array.isArray(q.options) || q.options.filter(Boolean).length === 0;
}

// TITA answers are graded as a normalized string match (case-insensitive,
// trimmed, with collapsed whitespace) so small formatting differences
// (e.g. trailing spaces, "12" vs "12 ") don't count against the student.
// For numeric-looking answers, also compare numerically so "12" === "12.0".
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

// ─── Question Status Dot ──────────────────────────────────────────────────────

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
      {flagged && (
        <span className="absolute -top-1 -right-1 w-3 h-3 bg-orange-400 rounded-full" />
      )}
    </button>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function SectionalTest({ user }: { user: any }) {
  const [view, setView] = useState<"list" | "instructions" | "test" | "result">("list");
  const [availableTests, setAvailableTests] = useState<SectionalTest[]>([]);
  const [attempts, setAttempts] = useState<Record<string, SectionalResult>>({});
  const [selectedTest, setSelectedTest] = useState<SectionalTest | null>(null);
  const [loading, setLoading] = useState(true);

  // Test state
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [titaDraft, setTitaDraft] = useState(""); // local input buffer for the current TITA question
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [timeLeft, setTimeLeft] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult] = useState<SectionalResult | null>(null);
  const [activePassage, setActivePassage] = useState<Passage | null>(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [testLoading, setTestLoading] = useState(false);

  // ── Load tests ──────────────────────────────────────────────────────────────
  useEffect(() => {
    loadTests();
  }, []);

  const loadTests = async () => {
    setLoading(true);
    try {
      const [tests, prevResults] = await Promise.all([
        apiRequest("/sectional-tests"),
        apiRequest("/sectional-results"),
      ]);
      setAvailableTests(tests || []);
      const map: Record<string, SectionalResult> = {};
      (prevResults || []).forEach((r: SectionalResult) => {
        map[r.testId] = r;
      });
      setAttempts(map);
    } catch (err: any) {
      toast.error("Failed to load sectional tests");
    } finally {
      setLoading(false);
    }
  };

  // ── Timer ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (view !== "test" || submitted || timeLeft <= 0) return;
    if (timeLeft === 0) {
      handleSubmit();
      return;
    }
    const t = setInterval(() => setTimeLeft((p) => p - 1), 1000);
    return () => clearInterval(t);
  }, [view, submitted, timeLeft]);

  // Auto-submit when time hits 0
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

  // ── Actions ──────────────────────────────────────────────────────────────
  const startTest = async (test: SectionalTest) => {
    // If already attempted, fetch full test for review then show result
    if (attempts[test.id]) {
      setTestLoading(true);
      try {
        const fullTest = await apiRequest(`/sectional-test/${test.id}`);
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

    // Fetch full test (with all questions) before showing instructions
    setTestLoading(true);
    try {
      const fullTest = await apiRequest(`/sectional-test/${test.id}`);
      if (!fullTest?.questions?.length) {
        toast.error("This test has no questions yet. Please check the sheet data.");
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

  const toggleFlag = useCallback(
    (qId: string) => {
      setFlagged((prev) => {
        const next = new Set(prev);
        next.has(qId) ? next.delete(qId) : next.add(qId);
        return next;
      });
    },
    []
  );

  // Commit the TITA draft into the answers map (called on change/blur/nav)
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

    // Make sure the in-progress TITA draft is saved before grading
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

    selectedTest.questions.forEach((q) => {
      const ans = finalAnswers[q.id];
      if (!ans) {
        skipped++;
      } else if (isTitaQuestion(q)) {
        if (isTitaCorrect(ans, q.correctAnswer)) correct++;
        else wrong++;
      } else if (ans === q.correctAnswer) {
        correct++;
      } else {
        wrong++;
      }
    });

    const total = selectedTest.questions.length;
    const scaledScore = calcScaledScore(correct, wrong, total);
    const totalScore = Math.round((correct / total) * 100);
    const timeSpent = selectedTest.durationMinutes * 60 - timeLeft;

    const payload: SectionalResult = {
      testId: selectedTest.id,
      section: selectedTest.section,
      totalScore,
      correctAnswers: correct,
      wrongAnswers: wrong,
      skippedQuestions: skipped,
      timeSpent,
      studentAnswers: finalAnswers,
      scaledScore,
    };

    try {
      await apiRequest("/sectional-results", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setResult(payload);
      setAnswers(finalAnswers);
      setAttempts((prev) => ({ ...prev, [selectedTest.id]: payload }));
      setView("result");
      toast.success("Section submitted!");
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
    const grouped = (["VARC", "DILR", "Quantitative"] as const).reduce(
      (acc, sec) => {
        acc[sec] = availableTests.filter((t) => t.section === sec);
        return acc;
      },
      {} as Record<string, SectionalTest[]>
    );

    return (
      <div className="space-y-8">
        <header>
          <h1 className="text-3xl font-bold tracking-tight">Sectional Tests</h1>
          <p className="text-muted-foreground mt-1">
            CAT-pattern section-wise mocks · 40 min · Real exam interface
          </p>
        </header>

        {/* CAT Pattern Info */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(["VARC", "DILR", "Quantitative"] as const).map((sec) => {
            const meta = SECTION_META[sec];
            return (
              <div
                key={sec}
                className={`rounded-xl p-4 border ${meta.lightColor} ${meta.borderColor}`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className={`w-2 h-2 rounded-full ${meta.color}`} />
                  <span className={`text-xs font-bold uppercase tracking-wider ${meta.textColor}`}>
                    {meta.short}
                  </span>
                </div>
                <p className="font-semibold text-sm">{meta.label}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {meta.questions} Qs · {meta.minutes} min
                </p>
              </div>
            );
          })}
        </div>

        {availableTests.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center border border-dashed rounded-2xl bg-background">
            <BookOpen className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <h3 className="font-bold text-lg">No Sectional Tests Available</h3>
            <p className="text-muted-foreground max-w-sm mt-1">
              Your admin hasn't published any sectional tests yet. Check back soon.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {(["VARC", "DILR", "Quantitative"] as const).map((sec) => {
              const tests = grouped[sec];
              if (!tests?.length) return null;
              const meta = SECTION_META[sec];
              return (
                <div key={sec}>
                  <div className="flex items-center gap-3 mb-4">
                    <div className={`w-3 h-3 rounded-full ${meta.color}`} />
                    <h2 className="font-bold text-lg">{meta.label}</h2>
                    <Badge variant="secondary">{tests.length} tests</Badge>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {tests.map((t) => {
                      const attempted = attempts[t.id];
                      return (
                        <Card
                          key={t.id}
                          className={`hover:shadow-md transition-all border-t-4 ${meta.color.replace("bg-", "border-t-")}`}
                        >
                          <CardHeader className="pb-2">
                            <div className="flex justify-between items-start">
                              <Badge
                                variant="outline"
                                className={`${meta.lightColor} ${meta.textColor} ${meta.borderColor} text-[10px] font-bold`}
                              >
                                {meta.short}
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
                          </CardHeader>
                          <CardContent className="space-y-3">
                            <div className="flex gap-4 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <Clock size={12} /> {t.durationMinutes} min
                              </span>
                              <span className="flex items-center gap-1">
                                <BookOpen size={12} /> {t.questions?.length ?? "–"} Qs
                              </span>
                            </div>
                            {attempted && (
                              <div className={`p-3 rounded-xl ${meta.lightColor} border ${meta.borderColor}`}>
                                <div className="flex gap-4 text-center">
                                  <div className="flex-1">
                                    <p className="text-[10px] font-bold uppercase text-muted-foreground">Score</p>
                                    <p className={`text-xl font-black ${meta.textColor}`}>
                                      {attempted.scaledScore}
                                    </p>
                                  </div>
                                  <div className="w-px bg-border" />
                                  <div className="flex-1">
                                    <p className="text-[10px] font-bold uppercase text-muted-foreground">Correct</p>
                                    <p className="text-xl font-black text-green-600">
                                      {attempted.correctAnswers}
                                    </p>
                                  </div>
                                  <div className="w-px bg-border" />
                                  <div className="flex-1">
                                    <p className="text-[10px] font-bold uppercase text-muted-foreground">Acc.</p>
                                    <p className="text-xl font-black">
                                      {attempted.totalScore}%
                                    </p>
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
                                : attempted ? "Review Attempt" : "Start Section"}
                            </Button>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── INSTRUCTIONS ─────────────────────────────────────────────────────────────
  if (view === "instructions" && selectedTest) {
    const meta = SECTION_META[selectedTest.section];
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Button variant="ghost" className="gap-2" onClick={() => setView("list")}>
          <ArrowLeft size={16} /> Back
        </Button>
        <Card className={`border-2 ${meta.borderColor}`}>
          <CardHeader className={`${meta.lightColor} rounded-t-xl`}>
            <div className={`text-xs font-bold uppercase tracking-widest ${meta.textColor} mb-1`}>
              {meta.short}
            </div>
            <CardTitle className="text-2xl">{selectedTest.name}</CardTitle>
          </CardHeader>
          <CardContent className="pt-6 space-y-6">
            {/* Stats */}
            <div className="grid grid-cols-3 gap-4 text-center">
              {[
                ["Questions", selectedTest.questions?.length],
                ["Duration", `${selectedTest.durationMinutes} min`],
                ["Marking", "+3 / –1"],
              ].map(([label, val]) => (
                <div key={label} className="p-4 bg-secondary/30 rounded-xl">
                  <p className="text-2xl font-black">{val}</p>
                  <p className="text-xs text-muted-foreground font-bold uppercase mt-1">{label}</p>
                </div>
              ))}
            </div>

            {/* Rules */}
            <div className="space-y-3">
              <h3 className="font-bold text-sm uppercase tracking-wide text-muted-foreground">Instructions</h3>
              {[
                "This is a timed section test. The timer starts when you click Begin.",
                "Each correct answer earns +3 marks. Each wrong answer deducts –1 mark. Unattempted questions carry 0 marks.",
                "Some questions are Type-In-The-Answer (TITA) — there's no negative marking risk from guessing wrong, but you must type your answer in the box provided.",
                "You can navigate between questions freely and flag any question for later review.",
                "Once time is up, the section auto-submits. You can also submit early.",
                "Answers cannot be changed after submission.",
              ].map((rule, i) => (
                <div key={i} className="flex gap-3 text-sm">
                  <span className={`w-5 h-5 shrink-0 rounded-full ${meta.color} text-white flex items-center justify-center text-[10px] font-bold mt-0.5`}>
                    {i + 1}
                  </span>
                  <p className="text-muted-foreground">{rule}</p>
                </div>
              ))}
            </div>

            <Button size="lg" className="w-full" onClick={beginTest}>
              Begin Section · {selectedTest.durationMinutes} min
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
          <Button onClick={() => setView("list")}>Back to Tests</Button>
        </div>
      );
    }
    const currentQ = questions[currentIdx];
    if (!currentQ) return null;
    const meta = SECTION_META[selectedTest.section];
    const answeredCount = Object.keys(answers).length;
    const progress = (answeredCount / questions.length) * 100;
    const currentIsTita = isTitaQuestion(currentQ);

    const goToIdx = (newIdx: number) => {
      // Persist whatever's in the TITA draft before navigating away
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
              <Badge className={`${meta.color} text-white border-none`}>{meta.short}</Badge>
              <span className="text-sm font-medium hidden sm:block truncate max-w-[200px]">
                {selectedTest.name}
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
            {/* Passage panel */}
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
                  <div className="text-sm leading-relaxed text-muted-foreground max-h-56 overflow-y-auto pr-2 space-y-3">
                    {activePassage.text.split("\n\n").map((para, i) => (
                      <p key={i}>{para}</p>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Question Card */}
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
  <Latex>{currentQ.questionText}</Latex>
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
                            ? `border-primary bg-blue-50 ring-1 ring-primary`
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
                {/* Legend */}
                <div className="space-y-1.5 text-xs text-muted-foreground border-t pt-3">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded bg-blue-500" />
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

            {/* Section summary */}
            <Card className={`border ${meta.borderColor}`}>
              <CardContent className="pt-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Section</span>
                  <span className={`font-bold ${meta.textColor}`}>{meta.short}</span>
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
    const meta = SECTION_META[selectedTest.section as keyof typeof SECTION_META];
    const questions = selectedTest.questions;

    if (reviewMode) {
      return (
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={() => setReviewMode(false)} className="gap-1">
              <ArrowLeft size={16} /> Back to Results
            </Button>
            <span className="font-bold">{selectedTest.name} · Review</span>
          </div>
          <div className="space-y-4">
            {questions.map((q, idx) => {
              const studentAns = result.studentAnswers[q.id];
              const qIsTita = isTitaQuestion(q);
              const isCorrect = qIsTita
                ? isTitaCorrect(studentAns, q.correctAnswer)
                : studentAns === q.correctAnswer;
              const isSkipped = !studentAns;
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
                        <Badge variant="outline">{q.section}</Badge>
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
                      Q{idx + 1}. <Latex>{q.questionText}</Latex>
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
    const rawMarks = result.correctAnswers * 3 - result.wrongAnswers;
    const maxMarks = questions.length * 3;
    const attemptRate = Math.round(((result.correctAnswers + result.wrongAnswers) / questions.length) * 100);

    return (
      <div className="max-w-3xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={() => setView("list")} className="gap-1">
            <ArrowLeft size={16} /> All Tests
          </Button>
        </div>

        {/* Score hero */}
        <Card className={`border-2 ${meta.borderColor} overflow-hidden`}>
          <div className={`${meta.color} px-6 py-5 text-white`}>
            <p className="text-sm font-bold uppercase tracking-widest opacity-80">{meta.label}</p>
            <h2 className="text-2xl font-black mt-1">{selectedTest.name}</h2>
          </div>
          <CardContent className="pt-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
              {[
                { label: "Scaled Score", val: result.scaledScore, color: meta.textColor, big: true },
                { label: "Raw Marks", val: `${rawMarks}/${maxMarks}`, color: "text-foreground" },
                { label: "Accuracy", val: `${result.totalScore}%`, color: "text-foreground" },
                {
                  label: "Time Taken",
                  val: `${Math.floor(result.timeSpent / 60)}m ${result.timeSpent % 60}s`,
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

        {/* Breakdown */}
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

        {/* Attempt rate bar */}
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
            <BarChart3 size={16} /> Back to Tests
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
