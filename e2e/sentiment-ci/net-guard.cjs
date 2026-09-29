// No-network guard for the sentiment integration matrix. Loaded via NODE_OPTIONS=--require into every Node process
// of the step (vitest workers included): it records every outbound socket target and refuses non-loopback hosts, so a
// real provider request surfaces as a hard failure instead of silent spend.
"use strict";
const net = require("node:net");
const fs = require("node:fs");

const LOG = process.env.SENTIMENT_NET_GUARD_LOG || "/tmp/sentiment-net-guard.log";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"]);

function record(line) {
	try {
		fs.appendFileSync(LOG, `${new Date().toISOString()} pid=${process.pid} ${line}\n`);
	} catch {}
}

record(`guard-loaded argv=${process.argv.slice(1).join(" ").slice(0, 160)}`);

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
	let host;
	let port;
	let pathName;
	const first = args[0];
	if (Array.isArray(first)) {
		const o = first[0] || {};
		host = o.host;
		port = o.port;
		pathName = o.path;
	} else if (typeof first === "object" && first !== null) {
		host = first.host;
		port = first.port;
		pathName = first.path;
	} else if (typeof first === "string" && Number.isNaN(Number(first))) {
		pathName = first;
	} else {
		port = first;
		host = typeof args[1] === "string" ? args[1] : undefined;
	}
	if (pathName !== undefined) {
		record(`connect ipc path=${pathName} ALLOW`);
		return origConnect.apply(this, args);
	}
	const h = host === undefined ? "localhost" : String(host);
	const allowed = LOOPBACK.has(h) || h.startsWith("127.");
	record(`connect tcp host=${h} port=${port} ${allowed ? "ALLOW" : "BLOCK"}`);
	if (!allowed) {
		const err = new Error(`sentiment net guard: refused outbound connection to ${h}:${port}`);
		err.code = "SENTIMENT_NET_GUARD_BLOCKED";
		process.nextTick(() => this.destroy(err));
		return this;
	}
	return origConnect.apply(this, args);
};
