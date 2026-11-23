// Runs under the same Node/Bun executable as Pi. Do not spawn the shell until
// Pi has assigned this launcher to its Windows Job Object.
import { spawn } from "node:child_process";
import { connect } from "node:net";

// Console signals also reach this supervisor. Let the command handle them
// and keep forwarding its actual exit code and inherited output.
process.on("SIGINT", () => {});
process.on("SIGBREAK", () => {});

function fail(error) {
	process.stderr.write(`Windows launcher: ${error.message}\n`, () => process.exit(1));
}

const socket = connect(process.argv[2]);
let configuration = "";
socket.setEncoding("utf8");
socket.on("data", (chunk) => { configuration += chunk; });
socket.on("error", fail);
socket.on("end", () => {
	try {
		const { command, windowsVerbatimArguments } = JSON.parse(configuration);
		const [file, ...args] = command;
		const child = spawn(file, args, {
			stdio: "inherit",
			windowsHide: true,
			windowsVerbatimArguments,
		});
		child.on("error", fail);
		child.on("exit", (code) => process.exit(code ?? 1));
	} catch (error) {
		fail(error);
	}
});
