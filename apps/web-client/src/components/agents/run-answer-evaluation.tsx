'use client';
import { useEffect, useState } from 'react';
import { projectRequest } from '@/lib/projects/client';
import styles from './analysis-evaluation.module.css';

type ToolSelection = { accuracy: number; required: string[]; used: string[]; matched: string[]; missing: string[]; unexpected: string[] };
type Evaluation = { state: 'pending' | 'scored'; expected: Record<string, unknown>; result: null | { error: string | null; success: boolean; tool_selection?: ToolSelection | null; parsed: null | { answers: Record<string, unknown> }; fields: Record<string, { correct: boolean; present: boolean; actual: unknown }> }; latency_ms: number | null; repetitions: number; summary: { pass_k: Record<string, number> | null } };
export function RunAnswerEvaluation({ path }: { path: string }) {
	const [data, setData] = useState<Evaluation | null>(null);
	const [error, setError] = useState('');
	const [refresh, setRefresh] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		async function load() {
			try {
				const response = await projectRequest<{ evaluation: Evaluation | null }>(`${path}/answer-evaluation`, { signal: controller.signal });
				if (controller.signal.aborted) return;
				setData(response.evaluation);
				if (response.evaluation?.state === 'pending') timer = setTimeout(load, 2000);
			} catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to load answer scores.'); }
		}
		void load();
		return () => { controller.abort(); clearTimeout(timer); };
	}, [path, refresh]);
	if (error) return <p role='alert'>{error} <button className='button' onClick={() => { setError(''); setRefresh(n => n + 1); }}>Retry answer evaluation</button></p>;
	if (!data) return null;
	const fields = data.result ? Object.values(data.result.fields) : [];
	const correctness = fields.length ? 100 * fields.filter(f => f.correct).length / fields.length : null;
	return <section className={styles.root} aria-label='Answer evaluation'>
		<h3>Answer evaluation</h3>
		{data.state === 'pending' ? <p role='status'>Waiting for the worker to score this answer…</p> : <>
			<dl className={styles.metrics}>
				<div><dt>Answer correctness</dt><dd>{correctness === null ? '—' : `${correctness.toFixed(1)}%`}</dd></div>
				<div><dt>Task success</dt><dd>{data.result?.success ? '100%' : '0%'}</dd></div>
				<div><dt title={data.repetitions === 1 ? 'Single-attempt success rate. Repeated attempts are needed to measure consistency.' : `Success across all ${data.repetitions} attempts.`}>Reliability</dt><dd>{data.summary.pass_k?.[String(data.repetitions)] == null ? '—' : `${data.summary.pass_k[String(data.repetitions)].toFixed(1)}%`}</dd></div>
				{data.result?.tool_selection && <div><dt>Tool selection accuracy</dt><dd>{data.result.tool_selection.accuracy.toFixed(1)}%</dd></div>}
				<div><dt>Latency</dt><dd>{data.latency_ms === null ? '—' : `${(data.latency_ms / 1000).toFixed(2)} s`}</dd></div>
			</dl>
			{data.result?.error && <p role='status'>{data.result.error === 'invalid_answer_format' ? 'Invalid evaluation format. The original model answer is still displayed above.' : 'The execution did not complete successfully.'}</p>}
			<div className={styles.table}><table><thead><tr><th>Answer field</th><th>Expected</th><th>Actual</th><th>Match</th></tr></thead><tbody>{Object.entries(data.expected).map(([key, expected]) => <tr key={key}><td>{key}</td><td><pre>{JSON.stringify(expected)}</pre></td><td><pre>{data.result?.fields[key]?.present ? JSON.stringify(data.result.fields[key].actual) : 'Missing'}</pre></td><td>{data.result?.fields[key]?.correct ? 'Correct' : 'Incorrect'}</td></tr>)}</tbody></table></div>
			{data.result?.tool_selection && <div aria-label='Tool selection comparison'>
				<p><strong>Required tools:</strong> {data.result.tool_selection.required.join(', ')}</p>
				<p><strong>Tools used:</strong> {data.result.tool_selection.used.join(', ') || 'None'}</p>
				<p><strong>Missing:</strong> {data.result.tool_selection.missing.join(', ') || 'None'}</p>
				<p><strong>Extra tools:</strong> {data.result.tool_selection.unexpected.join(', ') || 'None'}</p>
				
			</div>}

			
		</>}
	</section>;
}
