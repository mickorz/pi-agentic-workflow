export const meta = {
  name: "translate",
  description: "demo",
}
const result = await agent("Reply in one short sentence confirming the translate workflow ran with args: " + JSON.stringify(args))
return result
