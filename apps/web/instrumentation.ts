export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPoller } = await import("./lib/poller");
    startPoller();
    const { sendStartupNotification } = await import("./lib/notify");
    void sendStartupNotification(new Date());
  }
}
