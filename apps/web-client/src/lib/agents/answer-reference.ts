import { isRecord } from '@/lib/http/response';
const supportedTools = ['list_files', 'read_file', 'execute_python'];
export function answerReference(text: string) {
	if (!text.trim()) return undefined;
	const value: unknown = JSON.parse(text);
	if (!isRecord(value)) throw new Error('Answer reference must be a JSON object.');
	const wrapped = isRecord(value.answers) || isRecord(value.expected);
	const expected = isRecord(value.answers) ? value.answers : isRecord(value.expected) ? value.expected : value;
	if ('required_tools' in value && !wrapped) throw new Error('Put the answer fields inside answers when providing required_tools.');
	if (!Object.keys(expected).length) throw new Error('Add at least one expected answer.');
	const tools = value.required_tools;
	if (tools !== undefined && (!Array.isArray(tools) || !tools.length || !tools.every(tool => typeof tool === 'string' && supportedTools.includes(tool)) || new Set(tools).size !== tools.length)) {
		throw new Error('required_tools must contain unique names: list_files, read_file or execute_python.');
	}
	return {
		expected,
		comparison: wrapped && value.comparison !== undefined ? value.comparison : Object.fromEntries(Object.keys(expected).map(key => [key, { type: 'exact' }])),
		...(tools !== undefined ? { required_tools: tools } : {}),
	};
}
