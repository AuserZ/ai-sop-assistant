"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { z } from "zod";
import type { DocumentUploadDto, UploadInput } from "@/server/documents/contracts";
import { accountSchema, buttonClassName, inputClassName, linkClassName } from "@/components/auth/client";
import {
  DocumentRequestError,
  initializeUpload,
  maximumUploadBytes,
  processingFailureMessage,
  processUpload,
  readUpload,
  uploadFailureMessage,
} from "./client";

type AccessState = "loading" | "anonymous" | "error" | "ADMIN" | "STAFF";
type UploadAttempt = { file: File; input: UploadInput };
const uploadTimeoutMilliseconds = 120_000;

function setUploadReference(id?: string) {
  const location = new URL(window.location.href);
  if (id) location.searchParams.set("document", id);
  else location.searchParams.delete("document");
  window.history.replaceState(null, "", `${location.pathname}${location.search}`);
}

export function UploadPanel() {
  const [access, setAccess] = useState<AccessState>("loading");
  const [refresh, setRefresh] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [document, setDocument] = useState<DocumentUploadDto | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const attempt = useRef<UploadAttempt | null>(null);
  const activeOperation = useRef<AbortController | null>(null);
  const { register, handleSubmit, getValues, setValue, reset, formState: { errors } } = useForm<{ title: string }>({ defaultValues: { title: "" } });
  const busy = phase !== null;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/account", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (response.status === 401) { if (!controller.signal.aborted) setAccess("anonymous"); return; }
        const result = z.object({ user: accountSchema }).safeParse(await response.json());
        if (!response.ok || !result.success) throw new Error("Account unavailable");
        if (controller.signal.aborted) return;
        setAccess(result.data.user.role);
        const reference = new URL(window.location.href).searchParams.get("document");
        if (reference && result.data.user.role === "ADMIN") {
          if (!z.uuid().safeParse(reference).success) throw new DocumentRequestError("NOT_FOUND");
          const saved = await readUpload(reference, controller.signal);
          if (!controller.signal.aborted) setDocument(saved.document);
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof DocumentRequestError) setError(failure.message);
        else setAccess("error");
      }
    })();
    return () => { controller.abort(); activeOperation.current?.abort(); };
  }, [refresh]);

  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (activeOperation.current) return;
    const controller = new AbortController();
    activeOperation.current = controller;
    setError(null);
    setPhase("Checking file...");
    try { await work(controller.signal); }
    catch (failure) {
      if (controller.signal.aborted) return;
      const code = failure instanceof DocumentRequestError ? failure.code : "UPLOAD_UNAVAILABLE";
      setError(new DocumentRequestError(code).message);
      if (code === "UNAUTHENTICATED" || code === "FORBIDDEN") {
        setDocument(null); attempt.current = null;
        setAccess(code === "UNAUTHENTICATED" ? "anonymous" : "STAFF");
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
    try { setDocument((await processUpload(id, signal)).document); }
    catch (failure) {
      if (failure instanceof DocumentRequestError && failure.code === "UPLOAD_FINALIZING") {
        setDocument((await readUpload(id, signal)).document);
      }
      throw failure;
    }
  }

  async function upload(selected: UploadAttempt, signal: AbortSignal) {
    const initialized = await initializeUpload(selected.input, signal);
    if (signal.aborted) return;
    setDocument(initialized.document);
    setUploadReference(initialized.document.id);
    if (initialized.document.uploadStatus === "ACCEPTED") return;
    if (initialized.upload) {
      const authorization = initialized.upload;
      if (authorization.sizeBytes !== selected.file.size) throw new DocumentRequestError("UPLOAD_SIZE_MISMATCH");
      setPhase("Uploading file...");
      const response = await fetch(authorization.url, { method: "PUT", body: selected.file,
        headers: authorization.headers, credentials: "omit", redirect: "error",
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
      setFileError("Choose a PDF or DOCX file."); fileInput.current?.focus(); return;
    }
    if (!file.size || file.size > maximumUploadBytes) {
      setFileError("Choose a nonempty file no larger than 20 MB."); fileInput.current?.focus(); return;
    }
    if (file.name.length > 200 || /[\\/\u0000-\u001f\u007f]/.test(file.name)) {
      setFileError("Use a file name of 200 characters or fewer, without path or control characters."); fileInput.current?.focus(); return;
    }
    const selectedFile = file;
    void run(async (signal) => {
      if (!attempt.current) {
        const digest = await crypto.subtle.digest("SHA-256", await selectedFile.arrayBuffer());
        if (signal.aborted) return;
        attempt.current = { file: selectedFile, input: {
          requestKey: crypto.randomUUID(), title: values.title.trim(), fileName: selectedFile.name,
          mimeType: selectedFile.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: selectedFile.size, sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
        } };
      }
      await upload(attempt.current, signal);
    });
  }

  function startAnother() {
    if (busy) return;
    attempt.current = null; setDocument(null); setFile(null); setError(null); setFileError(null); reset();
    setUploadReference();
  }

  function editForm() { attempt.current = null; setError(null); }

  if (access === "loading") return <section className="mt-8 min-h-64"><p role="status">Checking sign-in...</p></section>;
  if (access === "anonymous") return <section className="mt-8 space-y-4"><p>Sign in with your Admin account to upload SOPs.</p><Link href="/sign-in" className={linkClassName}>Sign in</Link></section>;
  if (access === "STAFF") return <p className="mt-8">Only Admins can upload SOPs.</p>;
  if (access === "error") return <section className="mt-8 space-y-4"><p role="alert">Sign-in status is temporarily unavailable.</p><button className={buttonClassName} onClick={() => { setAccess("loading"); setRefresh((value) => value + 1); }}>Retry</button></section>;

  function acceptedStatusMessage(saved: DocumentUploadDto) {
    if (saved.status === "PROCESSING") return "Processing SOP document...";
    if (saved.status === "PENDING_VERIFICATION") return "Extracted and ready for Admin verification.";
    if (saved.status === "ACTIVE") return "Verified and active for retrieval.";
    if (saved.status === "REJECTED") return "Extraction rejected during Admin verification.";
    if (saved.status === "FAILED") return processingFailureMessage(saved);
    return "Queued for processing.";
  }

  const canOpenReview =
    document?.uploadStatus === "ACCEPTED" &&
    (document.status === "PENDING_VERIFICATION" || document.status === "REJECTED" || document.status === "ACTIVE");

  return <section className="mt-8 space-y-6" aria-label="SOP upload" aria-busy={busy}>
    {document ? <>
      <div className="space-y-3" aria-label="Upload status">
        <h2 className="text-xl font-semibold">{document.uploadStatus === "ACCEPTED" ? "Upload saved" : "Upload status"}</h2>
        <p className="break-words font-medium">{document.title}</p>
        <p className="break-all">{document.fileName}</p>
        {document.uploadStatus === "ACCEPTED" ? (
          <>
            <p role={document.status === "FAILED" ? "alert" : undefined} className={document.status === "FAILED" ? "text-[#991b1b]" : undefined}>
              {acceptedStatusMessage(document)}
            </p>
            {(document.status === "PENDING_VERIFICATION" || document.status === "ACTIVE" || document.status === "REJECTED") && document.summary && (
              <p className="text-sm text-[#4b5563]">
                {document.summary.pageCount} {document.summary.pageCount === 1 ? "page" : "pages"}, {document.summary.chunkCount}{" "}
                {document.summary.chunkCount === 1 ? "chunk" : "chunks"}, {document.summary.issueCount}{" "}
                {document.summary.issueCount === 1 ? "review note" : "review notes"}
                {document.summary.hasPreview ? ", PDF preview ready." : "."}
              </p>
            )}
          </>
        ) : (
          <p>{document.uploadStatus === "FINALIZING" ? "The uploaded file is being checked." : document.uploadStatus === "AWAITING_UPLOAD" ? "The upload has not been accepted yet." : uploadFailureMessage(document)}</p>
        )}
      </div>
      <div className="flex flex-wrap gap-4">
        {document.uploadStatus !== "ACCEPTED" && <button className={buttonClassName} disabled={busy} onClick={() => void run(async (signal) => {
          if (attempt.current) await upload(attempt.current, signal);
          else await finish(document.id, signal);
        })}>{file ? "Retry upload" : "Check upload"}</button>}
        {canOpenReview && (
          <Link href={`/documents/${document.id}/verify`} className={buttonClassName}>
            Review and verify
          </Link>
        )}
        {document.uploadStatus === "ACCEPTED" && (document.status === "FAILED" || document.job?.state === "WAITING_FOR_PIPELINE") && (
          <button className={buttonClassName} disabled={busy} onClick={() => void run(async (signal) => {
            setPhase("Re-queuing processing...");
            setDocument((await processUpload(document.id, signal)).document);
          })}>Retry processing</button>
        )}
        {document.uploadStatus === "ACCEPTED" && (document.status === "UPLOADED" || document.status === "PROCESSING") && (
          <button className={linkClassName} disabled={busy} onClick={() => void run(async (signal) => {
            setPhase("Refreshing status...");
            setDocument((await readUpload(document.id, signal)).document);
          })}>Refresh status</button>
        )}
        <button className={document.uploadStatus === "ACCEPTED" && document.status !== "FAILED" && !canOpenReview ? buttonClassName : linkClassName} disabled={busy} onClick={startAnother}>Choose another file</button>
      </div>
    </> : <form noValidate className="max-w-xl space-y-6" onSubmit={(event) => { void handleSubmit(submit)(event); }} onChange={editForm}>
      <h2 className="text-xl font-semibold">Upload SOP</h2>
      <div className="space-y-2">
        <label htmlFor="sop-title" className="block font-medium">SOP title</label>
        <input id="sop-title" className={inputClassName} disabled={busy} maxLength={200}
          aria-invalid={Boolean(errors.title)} aria-describedby={errors.title ? "sop-title-error" : undefined}
          {...register("title", { required: "Enter the SOP title.", validate: (value) => value.trim().length > 0 || "Enter the SOP title.", maxLength: { value: 200, message: "Use a title of 200 characters or fewer." } })} />
        {errors.title && <p id="sop-title-error" className="text-[#991b1b]">{errors.title.message}</p>}
      </div>
      <div className="space-y-2">
        <label htmlFor="sop-file" className="block font-medium">SOP file</label>
        <input ref={fileInput} id="sop-file" type="file" accept=".pdf,.docx" disabled={busy}
          className={`${inputClassName} min-w-0 cursor-pointer file:cursor-pointer file:font-medium`}
          aria-invalid={Boolean(fileError)} aria-describedby={`sop-file-help${fileError ? " sop-file-error" : ""}`}
          onChange={(event) => {
            const selected = event.target.files?.[0] ?? null;
            setFile(selected); setFileError(null);
            if (selected && !getValues("title").trim()) setValue("title", selected.name.replace(/\.(pdf|docx)$/i, "").slice(0, 200));
          }} />
        <p id="sop-file-help" className="text-sm text-[#4b5563]">PDF or DOCX. Maximum 20 MB.</p>
        {file && <p className="break-all text-sm">Selected: {file.name}</p>}
        {fileError && <p id="sop-file-error" className="text-[#991b1b]" role="alert">{fileError}</p>}
      </div>
      <button className={buttonClassName} disabled={busy} type="submit">Upload SOP</button>
    </form>}
    <p className="min-h-6 text-[#4b5563]" role="status">{phase}</p>
    {error && <p role="alert" className="text-[#991b1b]">{error}</p>}
  </section>;
}
