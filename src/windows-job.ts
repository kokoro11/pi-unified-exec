import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { Job } from "@seydx/win-job";

const launcher = fileURLToPath(new URL("./windows-launcher.js", import.meta.url));

/**
 * The launcher waits on a private pipe until it belongs to the job. Assigning
 * an already-running shell would race its first fork, leaving early descendants
 * outside the job. The job handle stays in Pi, including after the shell exits.
 */
export class WindowsJob {
	readonly command: string[];
	failureMessage?: string;
	private readonly job: Job;
	private readonly server;
	private socket?: Socket;
	private assigned = false;
	private killRequested = false;
	private closed = false;

	constructor(
		command: string[],
		windowsVerbatimArguments: boolean | undefined,
		private readonly getPid: () => number | undefined,
	) {
		const { Job } = createRequire(import.meta.url)("@seydx/win-job") as typeof import("@seydx/win-job");
		// A command that redirects its descendants' stdio can deliberately
		// detach them. Closing a completed session must preserve that behavior.
		this.job = new Job({ killOnClose: false });
		const pipe = `\\\\.\\pipe\\pi-unified-exec-${randomUUID()}`;
		this.command = [process.execPath, launcher, pipe];
		this.server = createServer((socket) => {
			this.socket = socket;
			this.server.close();
			socket.on("error", (error) => this.fail(error));
			try {
				const pid = this.getPid();
				if (!pid) throw new Error("launcher has no process ID");
				this.job.assign(pid);
				this.assigned = true;
				if (this.killRequested) {
					this.job.terminate();
					socket.destroy();
				} else {
					socket.end(JSON.stringify({ command, windowsVerbatimArguments }));
				}
			} catch (error) {
				this.fail(error);
			}
		});
		this.server.on("error", (error) => this.fail(error));
		this.server.listen(pipe);
	}

	kill(): void {
		if (this.closed) return;
		this.killRequested = true;
		if (this.assigned) {
			this.job.terminate();
		} else {
			// No command can start before assignment. An early kill only needs
			// to stop the launcher; ConPTY may publish its PID later.
			const pid = this.getPid();
			if (pid) process.kill(pid);
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.socket?.destroy();
		this.server.close();
		this.job.close();
	}

	private fail(error: unknown): void {
		this.failureMessage = `Windows job setup failed: ${error instanceof Error ? error.message : String(error)}`;
		try {
			this.kill();
		} catch {
			// Exit confirmation remains the caller's responsibility.
		}
	}
}
