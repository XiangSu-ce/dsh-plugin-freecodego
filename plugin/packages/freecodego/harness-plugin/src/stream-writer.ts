/**
 * One writer for one stream, and exactly one terminal frame.
 *
 * Why
 * ---
 * A model response is assembled from more than one asynchronous source: the
 * chunk loop, and any timer a deadline adds beside it. Both of them write to the
 * same `ServerResponse`, and both can decide the turn is over. Without an owner
 * for that decision two things go wrong, and neither is theoretical:
 *
 * - **A write after the end.** The stream is ended by whichever source finishes
 *   first, and the other one keeps writing into a finished response. Node raises
 *   `ERR_STREAM_WRITE_AFTER_END` on the response, which has no listener by
 *   default, so the failure surfaces as an unhandled error on a socket that is
 *   already gone.
 * - **Two terminal frames.** The client is told the turn failed and completed, in
 *   whatever order the race resolved. Every consumer of a streaming protocol
 *   keys on the terminal event, so one of the two answers is a lie about what
 *   happened.
 *
 * What this is not
 * ----------------
 * It is not a lock and it does not make concurrent *producers* safe: writes here
 * are synchronous, and JavaScript cannot interleave two synchronous calls. What
 * it owns is the two decisions a stream has — the order frames go out in, and
 * which frame is last — so that a late writer is refused instead of corrupting a
 * finished stream. The refusal is counted (`refusedWrites`) rather than thrown:
 * the caller that loses the race is usually a timer winding down, and throwing
 * there would replace a quiet no-op with an exception during teardown.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/stream-writer
 */

/** The part of a writable response this module needs. */
export interface StreamWriteTarget {
  write(chunk: string): unknown
  end(chunk?: string): unknown
  readonly writableEnded?: boolean
}

/**
 * Write frames to one target, ending it once.
 *
 * Frames are opaque strings: SSE framing belongs to whoever knows which protocol
 * is on the wire (this plugin speaks two), and moving it here would make this
 * module the place protocol changes have to be made in two dialects.
 */
export class StreamWriter {
  private ended = false
  private frames = 0
  private refused = 0
  private terminal = false

  constructor(private readonly target: StreamWriteTarget) {}

  /** Whether a terminal frame has been written. */
  get finished(): boolean {
    return this.ended
  }

  /** Frames actually delivered, terminal frame included. */
  get written(): number {
    return this.frames
  }

  /**
   * Writes that arrived after the stream was finished.
   *
   * Exposed because it is the only observable evidence that two producers were
   * racing: a caller seeing a non-zero count knows something wrote past the end,
   * and which of its two paths did it.
   */
  get refusedWrites(): number {
    return this.refused
  }

  /**
   * Deliver one frame.
   *
   * A frame that arrives after {@link StreamWriter.finish} is dropped and
   * counted: appending it would put bytes after the protocol's terminal event,
   * where the consumer either ignores them (a silent lie) or fails parsing.
   * @param frame - the complete wire frame, ending in its own separator.
   * @returns whether it was delivered.
   */
  write(frame: string): boolean {
    if (this.isFinished()) {
      this.refused += 1
      return false
    }
    this.frames += 1
    this.target.write(frame)
    return true
  }

  /**
   * Deliver the terminal frame and end the target.
   *
   * The first call wins. A second one is refused rather than appended, because
   * the difference between "the turn completed" and "the turn failed" is the
   * whole content of the terminal frame.
   * @param frame - the terminal frame, when the protocol has one.
   * @returns whether this call was the one that finished the stream.
   */
  finish(frame?: string): boolean {
    if (this.isFinished()) {
      this.refused += 1
      return false
    }
    // Only a frame makes this a terminal *frame*: the protocols here differ in
    // whether one exists, and a caller reading this flag to decide whether the
    // client was told the outcome must not be told `true` for a bare end.
    this.terminal = frame !== undefined
    if (frame !== undefined) {
      this.frames += 1
      this.target.write(frame)
    }
    this.ended = true
    this.target.end()
    return true
  }

  /**
   * Whether the stream is closed.
   *
   * Two sources of truth, deliberately: this writer's own flag, and the target
   * reporting that it is already ended. A response ended by something outside
   * this writer — a server shutdown, a destroyed socket — has to stop accepting
   * frames too, or the write-after-end this class exists to prevent happens
   * anyway.
   */
  private isFinished(): boolean {
    if (this.ended || this.target.writableEnded === true) {
      this.ended = true
      return true
    }
    return false
  }

  /** Whether a terminal frame has been written (as opposed to merely ended). */
  get hasTerminalFrame(): boolean {
    return this.terminal
  }
}
