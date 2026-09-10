/** Opt-in: sends two small requests to the public free tier; never run by npm test. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createModels, Type, type Context } from "@earendil-works/pi-ai";
import { zenProvider, PROVIDER_ID } from "../src/provider.ts";

const models = createModels(); models.setProvider(zenProvider());
const refreshed = await models.refresh();
assert.equal(refreshed.errors.size, 0, [...refreshed.errors.values()].join("; "));
const model = models.getModel(PROVIDER_ID, "muse-spark-1.3-contributor-free")!;
assert.ok(model);
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([size, t, data, crc]);
}
const raw = Buffer.alloc(64 * (1 + 64 * 3));
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
  const rgb = x >= 16 && x < 48 && y >= 16 && y < 48 ? [250, 230, 20] : [30, 50, 200];
  raw.set(rgb, y * 193 + 1 + x * 3);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
const context: Context = {
  systemPrompt: "Use record_colors to record the colors visible in the image. After its result, reply with the receipt code only.",
  messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: "Record the background and center-square colors in this image." }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }] }],
  tools: [{ name: "record_colors", description: "Record observed image colors and receive a receipt code.", parameters: Type.Object({ background: Type.String(), square: Type.String() }) }],
};
const options = { sessionId: randomUUID(), reasoning: "xhigh" as const, maxTokens: 4096, maxRetries: 0 };
const stream = models.streamSimple(model, context, options);
const types = new Set<string>(); for await (const event of stream) types.add(event.type);
const first = await stream.result();
assert.equal(first.stopReason, "toolUse", first.errorMessage ?? JSON.stringify(first.content.filter(b => b.type !== "thinking")));
const call = first.content.find(b => b.type === "toolCall")!;
assert.equal(call.name, "record_colors");
assert.match(String(call.arguments.background), /blue/i); assert.match(String(call.arguments.square), /yellow/i);
console.log(JSON.stringify({ check: "vision + native streaming tool call", passed: true, arguments: call.arguments, events: [...types], effort: first.providerThinkingLevel, reasoningTokens: first.usage.reasoning }));
context.messages.push(first, { role: "toolResult", toolCallId: call.id, toolName: call.name, timestamp: Date.now(), isError: false, content: [{ type: "text", text: "Receipt code: ZEN_7429" }] });
const second = await models.completeSimple(model, context, options);
assert.equal(second.stopReason, "stop", second.errorMessage);
const text = second.content.filter(b => b.type === "text").map(b => b.text).join("");
assert.match(text, /ZEN_7429/);
console.log(JSON.stringify({ check: "native tool result replay", passed: true, text }));
