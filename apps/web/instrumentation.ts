export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { seedCredentialsFromEnv } = await import("./lib/extCreds");
    seedCredentialsFromEnv();
    const { startPoller } = await import("./lib/poller");
    startPoller();
  }
}
