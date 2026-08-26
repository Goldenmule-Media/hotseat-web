/** The bench's fixed ports. Fixed, not ephemeral: `NEXT_PUBLIC_*` are inlined at BUILD time,
 *  so the stream URL has to be known before the build runs. 3110 deliberately avoids 3000/3100
 *  (a developer's `next dev`) and 4470 avoids 4437-4440 (wiki-server and the mirror). */
export const STREAM_PORT = Number(process.env["BENCH_STREAM_PORT"] ?? 4470);
export const NEXT_PORT = Number(process.env["BENCH_NEXT_PORT"] ?? 3110);
export const STREAM_URL = `http://127.0.0.1:${STREAM_PORT}`;
export const BASE_URL = `http://127.0.0.1:${NEXT_PORT}`;
/** Nothing listens here — MirrorIndicator must fail fast rather than find a real local mirror. */
export const MIRROR_URL = "http://127.0.0.1:4499";
