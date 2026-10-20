export const meta = {
  name: "summarize",
  description: "demo",
}
const result = await agent("Reply in one short sentence confirming the summarize workflow ran with args: " + JSON.stringify(args))
return result
