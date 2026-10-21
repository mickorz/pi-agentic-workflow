export const meta = { name: "real_hello", description: "single real agent" };
const reply = await agent("Reply with exactly the single word: OK", { label: "ok-sayer" })
return { reply }
