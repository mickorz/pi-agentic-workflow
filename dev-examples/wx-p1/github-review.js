export const meta = {
  name: "github-review",
  description: "demo",
}
const result = await agent("Reply in one short sentence confirming the github-review workflow ran with args: " + JSON.stringify(args))
return result
