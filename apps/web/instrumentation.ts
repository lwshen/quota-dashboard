export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPoller } = await import("@/server/usage/poller");
    startPoller();
    const { sendStartupNotification } = await import("@/server/notify");
    void sendStartupNotification(new Date());
  }
}
