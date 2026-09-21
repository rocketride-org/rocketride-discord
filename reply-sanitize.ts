// Rocket Ralph runs on a CrewAI/ReAct agent that occasionally emits its raw scratchpad
// ("Thought: …", "Action: …", "Observation: …", "Final Answer: …") instead of a clean
// reply — e.g. it posted a bare "Thought: … I should bring in the @RocketRide team …"
// straight to a user. This strips that scaffolding so the internal reasoning is never shown.
//
//   • If the text has an explicit "Final Answer:", keep only what follows the last one.
//   • If what remains still OPENS with a reasoning label (Thought/Action/Observation/…),
//     it is leaked reasoning with no real answer:
//       – if the agent decided to escalate (the text carries the team role mention),
//         replace it with a short, clean hand-off line that KEEPS the ping;
//       – otherwise return '' so the caller suppresses it and the bot stays quiet.
//   • Otherwise return the text unchanged.

const OPENS_WITH_REASONING = /^\s*(Thought|Action(?:\s+Input)?|Observation|Reasoning)\s*:/i;

export function sanitizeReply(text: string, roleMention: string): string {
	let t = (text ?? '').trim();
	if (!t) return t;

	// Prefer the content after the LAST explicit "Final Answer:" (drops the scratchpad above it).
	const marks = [...t.matchAll(/Final Answer\s*:\s*/gi)];
	if (marks.length) {
		const last = marks[marks.length - 1];
		const after = t.slice((last.index ?? 0) + last[0].length).trim();
		if (after) t = after;
	}

	// Still opens with a reasoning label → it's leaked scratchpad, not a user-facing answer.
	if (OPENS_WITH_REASONING.test(t)) {
		if (roleMention && t.includes(roleMention)) {
			return `Thanks for flagging this — I've looped in the ${roleMention} to take a look. 🙌`;
		}
		return ''; // pure reasoning, no answer, no escalation → suppress upstream
	}
	return t;
}
