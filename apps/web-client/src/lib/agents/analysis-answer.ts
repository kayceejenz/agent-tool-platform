/** Keep the readable explanation separate from evaluation fields without repairing answers. */
export function analysisAnswer(raw: string): { final_answer: string; answers: Record<string, unknown> } | null {
	try {
		let text = raw.trim();
		if (text.startsWith('```json\n') && text.endsWith('```')) text = text.slice(8, -3).trim();
		else if (text.startsWith('```\n') && text.endsWith('```')) text = text.slice(4, -3).trim();
		const data = JSON.parse(text);
		if (data && typeof data.final_answer === 'string' && data.final_answer.trim() && data.answers && typeof data.answers === 'object' && !Array.isArray(data.answers) && Object.keys(data).length === 2) return data;
	} catch { /* Preserve the original response if it is not an evaluation envelope. */ }
	return null;
}
