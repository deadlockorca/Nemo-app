export async function hiddenInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run in an interactive terminal.");
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let input = "";
    function finish() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stdout.write("\n");
    }
    function onData(data: Buffer) {
      for (const char of data.toString("utf8")) {
        if (char === "\u0003") { finish(); reject(new Error("Cancelled")); return; }
        if (char === "\r" || char === "\n") { finish(); resolve(input); return; }
        if (char === "\u007f" || char === "\b") input = Array.from(input).slice(0, -1).join("");
        else if (char >= " ") input += char;
      }
    }
    process.stdin.on("data", onData);
  });
}
