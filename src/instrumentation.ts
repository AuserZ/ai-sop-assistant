export async function register() {
  if (process.env.NEXT_PHASE !== "phase-production-build" && process.env.NEXT_RUNTIME === "nodejs" && process.env.WORKFLOW_DISPATCH_ENABLED === "1") {
    const { startWorkflowDispatcher } = await import("./server/jobs/dispatch");
    startWorkflowDispatcher();
  }
}
