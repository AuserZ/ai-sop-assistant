"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { AlertCircle, ArrowLeft, CheckCircle2, FileCheck2, Loader2, RefreshCw, Upload } from "lucide-react";
import { z } from "zod";
import type {
  DocumentLibraryResponse,
  DocumentUploadDto,
  UploadInput,
} from "@/server/documents/contracts";
import { accountSchema, buttonClassName, inputClassName, type Account } from "@/components/auth/client";
import { AppShell } from "@/components/layout/app-shell";
import { BrandMark, buttonClass, StatusBadge, textLinkBaseClassName } from "@/components/ui/primitives";
import {
  DocumentRequestError,
  initializeUpload,
  listLibraryDocuments,
  maximumUploadBytes,
  processingFailureMessage,
  processUpload,
  readUpload,
  uploadFailureMessage,
} from "./client";
import { LibraryPanel } from "./library-panel";

type AccessState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "error" }
  | { kind: "signed-in"; user: Account };
type UploadAttempt = { file: File; input: UploadInput };
const uploadTimeoutMilliseconds = 120_000;

function setUploadReference(id?: string) {
  const location = new URL(window.location.href);
  if (id) location.searchParams.set("document", id);
  else location.searchParams.delete("document");
  window.history.replaceState(null, "", `${location.pathname}${location.search}`);
}

export function UploadPanel() {
  const [access, setAccess] = useState<AccessState>({ kind: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  const [initialLibrary, setInitialLibrary] = useState<DocumentLibraryResponse | null>(null);
  const [initialLibraryError, setInitialLibraryError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [document, setDocument] = useState<DocumentUploadDto | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const attempt = useRef<UploadAttempt | null>(null);
  const activeOperation = useRef<AbortController | null>(null);
  const {
    register,
    handleSubmit,
    getValues,
    setValue,
    reset,
    formState: { errors },
  } = useForm<{ title: string }>({ defaultValues: { title: "" } });
  const busy = phase !== null;

  function applySavedDocument(nextDocument: DocumentUploadDto) {
    setDocument(nextDocument);
    setLibraryRefresh((value) => value + 1);
  }

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/account", {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) {
          if (!controller.signal.aborted) setAccess({ kind: "anonymous" });
          return;
        }
        const result = z.object({ user: accountSchema }).safeParse(await response.json());
        if (!response.ok || !result.success) throw new Error("Account unavailable");
        if (controller.signal.aborted) return;

        const reference = new URL(window.location.href).searchParams.get("document");
        if (reference && result.data.user.role === "ADMIN" && !z.uuid().safeParse(reference).success) {
          setAccess({ kind: "signed-in", user: result.data.user });
          throw new DocumentRequestError("NOT_FOUND");
        }

        const [libraryOutcome, savedOutcome] = await Promise.all([
          listLibraryDocuments({}, controller.signal)
            .then((data) => ({ data, error: null as string | null }))
            .catch((failure: unknown) => ({
              data: null,
              error:
                failure instanceof DocumentRequestError
                  ? failure.message
                  : "The SOP library is temporarily unavailable. Try again.",
            })),
          reference && result.data.user.role === "ADMIN"
            ? readUpload(reference, controller.signal)
            : Promise.resolve(null),
        ]);
        if (controller.signal.aborted) return;
        setInitialLibrary(libraryOutcome.data);
        setInitialLibraryError(libraryOutcome.error);
        if (savedOutcome) setDocument(savedOutcome.document);
        setAccess({ kind: "signed-in", user: result.data.user });
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof DocumentRequestError) setError(failure.message);
        else setAccess({ kind: "error" });
      }
    })();
    return () => {
      controller.abort();
      activeOperation.current?.abort();
    };
  }, [refresh]);

  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (activeOperation.current) return;
    const controller = new AbortController();
    activeOperation.current = controller;
    setError(null);
    setPhase("Checking file...");
    try {
      await work(controller.signal);
    } catch (failure) {
      if (controller.signal.aborted) return;
      const code = failure instanceof DocumentRequestError ? failure.code : "UPLOAD_UNAVAILABLE";
      setError(new DocumentRequestError(code).message);
      if (code === "UNAUTHENTICATED") {
        setDocument(null);
        attempt.current = null;
        setAccess({ kind: "anonymous" });
      } else if (code === "FORBIDDEN") {
        setDocument(null);
        attempt.current = null;
        setAccess((current) =>
          current.kind === "signed-in"
            ? { kind: "signed-in", user: { ...current.user, role: "STAFF" } }
            : current,
        );
      }
    } finally {
      if (activeOperation.current === controller) {
        activeOperation.current = null;
        if (!controller.signal.aborted) setPhase(null);
      }
    }
  }

  async function finish(id: string, signal: AbortSignal) {
    setPhase("Checking uploaded bytes...");
    try {
      applySavedDocument((await processUpload(id, signal)).document);
    } catch (failure) {
      if (failure instanceof DocumentRequestError && failure.code === "UPLOAD_FINALIZING") {
        applySavedDocument((await readUpload(id, signal)).document);
      }
      throw failure;
    }
  }

  async function upload(selected: UploadAttempt, signal: AbortSignal) {
    const initialized = await initializeUpload(selected.input, signal);
    if (signal.aborted) return;
    setDocument(initialized.document);
    setUploadReference(initialized.document.id);
    if (initialized.document.uploadStatus === "ACCEPTED") {
      setLibraryRefresh((value) => value + 1);
      return;
    }
    if (initialized.upload) {
      const authorization = initialized.upload;
      if (authorization.sizeBytes !== selected.file.size) throw new DocumentRequestError("UPLOAD_SIZE_MISMATCH");
      setPhase("Uploading file...");
      const response = await fetch(authorization.url, {
        method: "PUT",
        body: selected.file,
        headers: authorization.headers,
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(uploadTimeoutMilliseconds)]),
      });
      await response.body?.cancel();
      if (!response.ok && response.status !== 412) throw new DocumentRequestError("UPLOAD_STORAGE_UNAVAILABLE");
    }
    await finish(initialized.document.id, signal);
  }

  function submit(values: { title: string }) {
    setFileError(null);
    if (!file || !/\.(pdf|docx)$/i.test(file.name)) {
      setFileError("Choose a PDF or DOCX file.");
      fileInput.current?.focus();
      return;
    }
    if (!file.size || file.size > maximumUploadBytes) {
      setFileError("Choose a nonempty file no larger than 20 MB.");
      fileInput.current?.focus();
      return;
    }
    if (file.name.length > 200 || /[\\/\u0000-\u001f\u007f]/.test(file.name)) {
      setFileError("Use a file name of 200 characters or fewer, without path or control characters.");
      fileInput.current?.focus();
      return;
    }
    const selectedFile = file;
    void run(async (signal) => {
      if (!attempt.current) {
        const digest = await crypto.subtle.digest("SHA-256", await selectedFile.arrayBuffer());
        if (signal.aborted) return;
        attempt.current = {
          file: selectedFile,
          input: {
            requestKey: crypto.randomUUID(),
            title: values.title.trim(),
            fileName: selectedFile.name,
            mimeType: selectedFile.name.toLowerCase().endsWith(".pdf")
              ? "application/pdf"
              : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            sizeBytes: selectedFile.size,
            sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
          },
        };
      }
      await upload(attempt.current, signal);
    });
  }

  function startAnother() {
    if (busy) return;
    attempt.current = null;
    setDocument(null);
    setFile(null);
    setError(null);
    setFileError(null);
    reset();
    setUploadReference();
  }

  function editForm() {
    attempt.current = null;
    setError(null);
  }

  if (access.kind !== "signed-in") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10 sm:px-6">
        <div className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-6">
          <BrandMark />
          <h1 className="mt-5 text-2xl font-semibold text-[#0f172a]">List Document SOP</h1>
          {access.kind === "loading" && (
            <p role="status" className="mt-4 flex items-center gap-2 text-sm text-[#475569]">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
              <span>Checking sign-in...</span>
            </p>
          )}
          {access.kind === "anonymous" && (
            <div className="mt-4 space-y-4">
              <p className="text-sm text-[#475569]">
                Sign in with your Admin account to upload SOPs.
              </p>
              <Link href="/sign-in" className={buttonClass("primary", "default", "w-full")}>
                Sign in
              </Link>
            </div>
          )}
          {access.kind === "error" && (
            <div className="mt-4 space-y-4">
              <p role="alert" className="rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]">
                Sign-in status is temporarily unavailable.
              </p>
              <button
                type="button"
                className={buttonClassName}
                onClick={() => {
                  setAccess({ kind: "loading" });
                  setRefresh((value) => value + 1);
                }}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      </main>
    );
  }

  if (access.user.role === "STAFF") {
    return (
      <AppShell
        user={access.user}
        activeMenu="documents"
        onSignedOut={() => setAccess({ kind: "anonymous" })}
      >
        <div className="space-y-6">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e2e8f0] pb-4">
            <h1 className="text-2xl font-semibold text-[#0f172a]">List Document SOP</h1>
            <Link href="/" className={`${textLinkBaseClassName} hidden lg:inline-flex`}>
              <ArrowLeft className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
              <span>Back to account</span>
            </Link>
          </header>

          <LibraryPanel
            role="STAFF"
            initialData={initialLibrary}
            initialError={initialLibraryError}
            refreshSignal={libraryRefresh}
          />

          <p className="text-sm text-[#64748b]">Only Admins can upload SOPs.</p>
        </div>
      </AppShell>
    );
  }

  function acceptedStatusMessage(saved: DocumentUploadDto) {
    if (saved.status === "PROCESSING") return "Processing SOP document...";
    if (saved.status === "PENDING_VERIFICATION") return "Extracted and ready for Admin verification.";
    if (saved.status === "ACTIVE") return "Verified and active for retrieval.";
    if (saved.status === "REJECTED") return "Extraction rejected during Admin verification.";
    if (saved.status === "DELETED") return "This SOP document has been deleted.";
    if (saved.status === "FAILED") return processingFailureMessage(saved);
    return "Queued for processing.";
  }

  const canOpenReview =
    document?.uploadStatus === "ACCEPTED" &&
    (document.status === "PENDING_VERIFICATION" ||
      document.status === "REJECTED" ||
      document.status === "ACTIVE");

  return (
    <AppShell
      user={access.user}
      activeMenu="documents"
      onSignedOut={() => setAccess({ kind: "anonymous" })}
    >
      <div className="space-y-8">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e2e8f0] pb-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-[#0f172a]">List Document SOP</h1>
            <p className="mt-1 text-sm text-[#475569]">
              Upload private PDF or DOCX originals, verify extracted text, and manage active company SOPs.
            </p>
          </div>
          <Link href="/" className={`${textLinkBaseClassName} hidden lg:inline-flex`}>
            <ArrowLeft className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <span>Back to account</span>
          </Link>
        </header>

        <section
          className="space-y-5 rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 sm:p-6"
          aria-label="SOP upload"
          aria-busy={busy}
        >
          {document ? (
            <>
              <div className="space-y-3" aria-label="Upload status">
                <div className="flex flex-wrap items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-[#065f46]" strokeWidth={1.5} aria-hidden="true" />
                  <h2 className="text-lg font-semibold text-[#0f172a]">
                    {document.uploadStatus === "ACCEPTED" ? "Upload saved" : "Upload status"}
                  </h2>
                  {document.status && <StatusBadge label={document.status} />}
                </div>
                <p className="break-words font-medium text-[#0f172a]">{document.title}</p>
                <p className="break-all font-mono text-xs text-[#64748b]">{document.fileName}</p>
                {document.uploadStatus === "ACCEPTED" ? (
                  <>
                    <p
                      role={document.status === "FAILED" ? "alert" : undefined}
                      className={
                        document.status === "FAILED"
                          ? "rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]"
                          : "text-sm text-[#475569]"
                      }
                    >
                      {acceptedStatusMessage(document)}
                    </p>
                    {(document.status === "PENDING_VERIFICATION" ||
                      document.status === "ACTIVE" ||
                      document.status === "REJECTED") &&
                      document.summary && (
                        <p className="tabular-nums text-xs text-[#475569]">
                          {document.summary.pageCount}{" "}
                          {document.summary.pageCount === 1 ? "page" : "pages"},{" "}
                          {document.summary.chunkCount}{" "}
                          {document.summary.chunkCount === 1 ? "chunk" : "chunks"},{" "}
                          {document.summary.issueCount}{" "}
                          {document.summary.issueCount === 1 ? "review note" : "review notes"}
                          {document.summary.hasPreview ? ", PDF preview ready." : "."}
                        </p>
                      )}
                  </>
                ) : (
                  <p className="text-sm text-[#475569]">
                    {document.uploadStatus === "FINALIZING"
                      ? "The uploaded file is being checked."
                      : document.uploadStatus === "AWAITING_UPLOAD"
                        ? "The upload has not been accepted yet."
                        : uploadFailureMessage(document)}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-3">
                {document.uploadStatus !== "ACCEPTED" && (
                  <button
                    type="button"
                    className={buttonClass("primary")}
                    disabled={busy}
                    onClick={() =>
                      void run(async (signal) => {
                        if (attempt.current) await upload(attempt.current, signal);
                        else await finish(document.id, signal);
                      })
                    }
                  >
                    {file ? "Retry upload" : "Check upload"}
                  </button>
                )}
                {canOpenReview && (
                  <Link href={`/documents/${document.id}/verify`} className={buttonClass("primary")}>
                    <FileCheck2 className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                    <span>Review and verify</span>
                  </Link>
                )}
                {document.uploadStatus === "ACCEPTED" &&
                  (document.status === "FAILED" || document.job?.state === "WAITING_FOR_PIPELINE") && (
                    <button
                      type="button"
                      className={buttonClass("primary")}
                      disabled={busy}
                      onClick={() =>
                        void run(async (signal) => {
                          setPhase("Re-queuing processing...");
                          applySavedDocument((await processUpload(document.id, signal)).document);
                        })
                      }
                    >
                      Retry processing
                    </button>
                  )}
                {document.uploadStatus === "ACCEPTED" &&
                  (document.status === "UPLOADED" || document.status === "PROCESSING") && (
                    <button
                      type="button"
                      className={buttonClass("secondary")}
                      disabled={busy}
                      onClick={() =>
                        void run(async (signal) => {
                          setPhase("Refreshing status...");
                          applySavedDocument((await readUpload(document.id, signal)).document);
                        })
                      }
                    >
                      <RefreshCw className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                      <span>Refresh status</span>
                    </button>
                  )}
                <button
                  type="button"
                  className={
                    document.uploadStatus === "ACCEPTED" &&
                    document.status !== "FAILED" &&
                    !canOpenReview
                      ? buttonClass("primary")
                      : buttonClass("secondary")
                  }
                  disabled={busy}
                  onClick={startAnother}
                >
                  Choose another file
                </button>
              </div>
            </>
          ) : (
            <form
              noValidate
              className="max-w-xl space-y-5"
              onSubmit={(event) => {
                void handleSubmit(submit)(event);
              }}
              onChange={editForm}
            >
              <h2 className="text-lg font-semibold text-[#0f172a]">Upload SOP</h2>
              <div className="space-y-1.5">
                <label htmlFor="sop-title" className="block text-sm font-medium text-[#0f172a]">
                  SOP title
                </label>
                <input
                  id="sop-title"
                  className={inputClassName}
                  disabled={busy}
                  maxLength={200}
                  aria-invalid={Boolean(errors.title)}
                  aria-describedby={errors.title ? "sop-title-error" : undefined}
                  {...register("title", {
                    required: "Enter the SOP title.",
                    validate: (value) => value.trim().length > 0 || "Enter the SOP title.",
                    maxLength: { value: 200, message: "Use a title of 200 characters or fewer." },
                  })}
                />
                {errors.title && (
                  <p id="sop-title-error" className="text-sm text-[#991b1b]">
                    {errors.title.message}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <label htmlFor="sop-file" className="block text-sm font-medium text-[#0f172a]">
                  SOP file
                </label>
                <input
                  ref={fileInput}
                  id="sop-file"
                  type="file"
                  accept=".pdf,.docx"
                  disabled={busy}
                  className={`${inputClassName} min-w-0 cursor-pointer file:mr-3 file:cursor-pointer file:rounded-[var(--radius-sm)] file:border-0 file:bg-[#eff6ff] file:px-3 file:py-1 file:text-xs file:font-medium file:text-[#1d4ed8]`}
                  aria-invalid={Boolean(fileError)}
                  aria-describedby={`sop-file-help${fileError ? " sop-file-error" : ""}`}
                  onChange={(event) => {
                    const selected = event.target.files?.[0] ?? null;
                    setFile(selected);
                    setFileError(null);
                    if (selected && !getValues("title").trim()) {
                      setValue("title", selected.name.replace(/\.(pdf|docx)$/i, "").slice(0, 200));
                    }
                  }}
                />
                <p id="sop-file-help" className="text-xs text-[#475569]">
                  PDF or DOCX. Maximum 20 MB.
                </p>
                {file && (
                  <p className="break-all font-mono text-xs text-[#475569]">Selected: {file.name}</p>
                )}
                {fileError && (
                  <p id="sop-file-error" className="text-sm text-[#991b1b]" role="alert">
                    {fileError}
                  </p>
                )}
              </div>
              <button className={buttonClass("primary")} disabled={busy} type="submit">
                {busy ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
                ) : (
                  <Upload className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                )}
                <span>Upload SOP</span>
              </button>
            </form>
          )}

          {phase && (
            <p className="flex items-center gap-2 text-sm text-[#475569]" role="status">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
              <span>{phase}</span>
            </p>
          )}

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
        </section>

        <LibraryPanel
          role="ADMIN"
          initialData={initialLibrary}
          initialError={initialLibraryError}
          refreshSignal={libraryRefresh}
        />
      </div>
    </AppShell>
  );
}
