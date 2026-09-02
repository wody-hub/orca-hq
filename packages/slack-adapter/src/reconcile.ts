export type SlackHistoryPage = Readonly<{
  messages: readonly unknown[];
  nextCursor: string | undefined;
}>;

export type SlackHistoryPort = Readonly<{
  listMessages(request: Readonly<{
    channelId: string;
    /** Durable Slack timestamp high-water mark from a prior completed reconciliation. */
    cursor: string | undefined;
    /** Ephemeral provider pagination token; it is never persisted as a channel cursor. */
    pageCursor: string | undefined;
  }>): Promise<SlackHistoryPage>;
}>;

export type ChannelCursorStore = Readonly<{
  load(): Promise<string | undefined>;
  save(cursor: string): Promise<void>;
}>;

export async function reconcileSlackHistory(
  options: Readonly<{
    channelId: string;
    cursorStore: ChannelCursorStore;
    history: SlackHistoryPort;
    handleEvent(event: unknown): Promise<void>;
  }>
): Promise<void> {
  const cursor = await options.cursorStore.load();
  let pageCursor: string | undefined;
  let highWaterMark = cursor;

  do {
    const page = await options.history.listMessages({
      channelId: options.channelId,
      cursor,
      pageCursor
    });
    for (const event of page.messages) {
      await options.handleEvent(event);
      if (isLaterSlackTimestamp(event, highWaterMark)) {
        highWaterMark = event.ts;
      }
    }
    pageCursor = page.nextCursor;
  } while (pageCursor !== undefined);

  if (highWaterMark !== undefined && highWaterMark !== cursor) {
    await options.cursorStore.save(highWaterMark);
  }
}

function isLaterSlackTimestamp(
  event: unknown,
  highWaterMark: string | undefined
): event is Readonly<{ ts: string }> {
  if (typeof event !== "object" || event === null ||
    typeof (event as Record<string, unknown>).ts !== "string") return false;
  const timestamp = (event as Readonly<{ ts: string }>).ts;
  if (!/^\d+(?:\.\d+)?$/.test(timestamp)) return false;
  return highWaterMark === undefined || !/^\d+(?:\.\d+)?$/.test(highWaterMark) ||
    Number(timestamp) > Number(highWaterMark);
}
