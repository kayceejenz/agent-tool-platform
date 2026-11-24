'use client';
import { useEffect, useState } from 'react';
import { projectRequest, projectWrite } from '@/lib/projects/client';
import { AnalysisDatasetPicker } from './analysis-dataset-picker';
import { ReadableText } from '@/components/content/readable-text';
import { ExecutionTrace } from './execution-trace';
import { ExecutionArtifacts } from './execution-artifacts';
import styles from './analysis-evaluation.module.css';

type Suite = { name: string; cases: { id: string; question: string; expected: Record<string, unknown>; comparison: Record<string, unknown>; required_tools?: string[] }[] };
type Attempt = { id: string; case_id: string; attempt: number; execution_id: string | null; execution_status: string | null; raw_answer: string | null; termination_reason: string | null; latency_ms: number | null; result: null | { error: string | null; success: boolean; parsed: null | { final_answer: string; answers: Record<string, unknown> }; tool_selection?: { accuracy: number; required: string[]; used: string[]; missing: string[]; unexpected: string[] } | null; fields: Record<string, { correct: boolean; present: boolean; actual: unknown }> } };
type Batch = { id: string; name: string; status: string; agent_revision: number; repetitions: number; suite: Suite; dataset: { name: string }; attempts: Attempt[]; summary: { finished: number; total: number; timed_attempts: number; answer_correctness: number | null; tool_selection_accuracy?: number | null; tool_scored_attempts?: number; task_success_rate: number | null; pass_k: Record<string, number> | null; median_latency_ms: number | null; p95_latency_ms: number | null } };
type History = { items: { id: string; name: string; status: string }[]; next_offset: number | null };
const example: Suite = { name: 'Pig trial starter', cases: [{ id: 'PIG-001', question: 'How many data rows are in behaviour_events.csv, excluding the header?', expected: { event_count: 313820 }, comparison: { event_count: { type: 'exact' } } }] };
const percent = (n: number | null | undefined) => n == null ? '—' : `${n.toFixed(1)}%`;
const seconds = (n: number | null) => n == null ? '—' : `${(n / 1000).toFixed(2)} s`;
const reason: Record<string, string> = { invalid_answer_format: 'Invalid evaluation format', execution_failed: 'Execution did not complete', access_or_configuration_changed: 'Access or agent configuration changed' };

export function AnalysisEvaluation({ projectId, agentId, revision, enabled, canRun }: { projectId: string; agentId: string; revision: number; enabled: boolean; canRun: boolean }) {
	const base = `/${projectId}/agents/${agentId}/analysis-evaluations`;
	const [dataset, setDataset] = useState('');
	const [suite, setSuite] = useState<Suite | null>(null);
	const [repetitions, setRepetitions] = useState(1);
	const [history, setHistory] = useState<History>({ items: [], next_offset: null });
	const [batchId, setBatchId] = useState('');
	const [batch, setBatch] = useState<Batch | null>(null);
	const [selected, setSelected] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const [requestId, setRequestId] = useState('');
	useEffect(() => {
		const controller = new AbortController();
		void projectRequest<History>(base, { signal: controller.signal }).then(page => {
			setHistory(page);
			setBatchId(id => id || page.items[0]?.id || '');
		}).catch(e => { if (!controller.signal.aborted) setError(e.message); });
		return () => controller.abort();
	}, [base, refresh]);
	useEffect(() => {
		if (!batchId) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			try {
				const result = await projectRequest<Batch>(`${base}/${batchId}`, { signal: controller.signal });
				if (controller.signal.aborted) return;
				setBatch(result);
				setHistory(h => ({ ...h, items: h.items.map(item => item.id === result.id ? { ...item, status: result.status } : item) }));
				if (result.status === 'running' || result.status === 'cancelling') timer = setTimeout(poll, 2000);
			} catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to load evaluation.'); }
		}
		void poll();
		return () => { controller.abort(); clearTimeout(timer); };
	}, [base, batchId, refresh]);
	async function upload(file?: File) {
		setError(''); setSuite(null); setRequestId('');
		if (!file) return;
		if (file.size > 200000) { setError('Suite must be at most 200 KB.'); return; }
		try {
			const value = JSON.parse(await file.text());
			if (!value || typeof value.name !== 'string' || !Array.isArray(value.cases) || !value.cases.length || value.cases.length > 50) throw new Error('Use a named suite with 1 to 50 cases.');
			setSuite(value);
		} catch (e) { setError(e instanceof Error ? e.message : 'Invalid suite JSON.'); }
	}
	async function start() {
		if (!suite || !dataset) return;
		setBusy(true); setError('');
		const id = requestId || crypto.randomUUID(); setRequestId(id);
		try {
			const result = await projectWrite<{ id: string }>(base, 'POST', { request_id: id, revision, dataset_id: dataset, attempts: repetitions, suite });
			setBatch(null); setBatchId(result.id); setSelected(''); setRefresh(n => n + 1); setRequestId('');
		} catch (e) { setError(e instanceof Error ? e.message : 'Unable to start evaluation.'); }
		finally { setBusy(false); }
	}
	async function cancel() {
		setBusy(true); setError('');
		try { await projectWrite(`${base}/${batchId}/cancel`, 'POST', {}); setRefresh(n => n + 1); }
		catch (e) { setError(e instanceof Error ? e.message : 'Unable to cancel.'); }
		finally { setBusy(false); }
	}
	const attempt = batch?.attempts.find(a => a.id === selected);
	const active = batch?.status === 'running' || batch?.status === 'cancelling';
	function download(value: unknown, filename: string) {
		const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
		const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
	}
	return <section className={styles.root} aria-label='Dataset evaluation'>
		<h3>Evaluate this agent</h3>
		{error && <p role='alert' className='project-error'>{error} <button className='button' onClick={() => { setError(''); setRefresh(n => n + 1); }}>Reconnect</button></p>}
		{canRun && <form className={styles.form} onSubmit={e => { e.preventDefault(); void start(); }}>
			<AnalysisDatasetPicker projectId={projectId} value={dataset} onChange={value => { setDataset(value); setRequestId(''); }} disabled={busy} />
			<label className='tool-field'>Test suite JSON<input aria-label='Test suite JSON' type='file' accept='.json,application/json' disabled={busy} onChange={e => void upload(e.target.files?.[0])} /></label>
			{suite && <p>{suite.name}: {suite.cases.length} questions × {repetitions} attempts = {suite.cases.length * repetitions} executions</p>}
			<div className={styles.controls}>
				<label>Attempts per question <select aria-label='Attempts per question' disabled={busy} value={repetitions} onChange={e => { setRepetitions(Number(e.target.value)); setRequestId(''); }}><option value={1}>1</option><option value={5}>5</option></select></label>
				<button className='button primary' disabled={busy || !enabled || !dataset || !suite || active}>Run evaluation</button>
				<button className='button' type='button' onClick={() => download(example, 'evaluation-suite-example.json')}>Download example suite</button>
			</div>
			<p className={styles.help}>Exact comparisons support JSON values. For numeric_tolerance, set absolute_tolerance and relative_tolerance. Completed batches are immutable. Keep this agent revision enabled while the batch runs.</p>
		</form>}
		<div className={styles.history} aria-label='Evaluation history'>{history.items.map(item => <button key={item.id} className='button' aria-pressed={item.id === batchId} onClick={() => { setBatch(null); setSelected(''); setBatchId(item.id); }}>{item.name} · {item.status}</button>)}
		{history.next_offset !== null && <button className='button' onClick={async () => { try { const page = await projectRequest<History>(`${base}?offset=${history.next_offset}`); setHistory(h => ({ items: [...h.items, ...page.items], next_offset: page.next_offset })); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load history.'); } }}>More evaluations</button>}</div>
		{batch && <>
			<div className={styles.controls}><h3>{batch.name}</h3><span role='status'>{batch.status} · {batch.summary.finished}/{batch.summary.total} attempts scored</span>
				{canRun && batch.status === 'running' && <button className='button' disabled={busy} onClick={() => void cancel()}>Cancel evaluation</button>}
				<button className='button' onClick={() => download(batch, `evaluation-${batch.id}.json`)}>Export results</button>
			</div>
			<p className={styles.help}>Agent revision {batch.agent_revision} · Dataset: {batch.dataset.name}. Final correctness and reliability appear when every attempt is scored. Cancelled batches retain results but have no final aggregate scores.</p>
			<dl className={styles.metrics}>
				<div><dt>Answer correctness</dt><dd>{percent(batch.summary.answer_correctness)}</dd></div>
				<div><dt>Task success rate</dt><dd>{percent(batch.summary.task_success_rate)}</dd></div>
				<div><dt>Reliability pass^{batch.repetitions}</dt><dd>{percent(batch.summary.pass_k?.[String(batch.repetitions)])}</dd></div>
				{!!batch.summary.tool_scored_attempts && <div><dt>Tool selection accuracy</dt><dd>{percent(batch.summary.tool_selection_accuracy)}</dd></div>}
				<div><dt>Median latency</dt><dd>{seconds(batch.summary.median_latency_ms)}</dd></div>
				<div><dt>p95 latency</dt><dd>{seconds(batch.summary.p95_latency_ms)}</dd></div>
			</dl>
			<p className={styles.help}>Correctness measures required fields. Task success requires a completed execution and every field correct. Reliability requires success on all selected repeats. Latency excludes queue wait, using {batch.summary.timed_attempts} timed attempts. These scores do not independently validate the prose explanation.</p>
			<div className={styles.table}><table><thead><tr><th>Question</th><th>Attempt</th><th>Expected</th><th>Actual</th><th>Result</th><th>Tools</th><th>Latency</th></tr></thead><tbody>{batch.attempts.map(a => <tr key={a.id}>
				<td><button className='button' onClick={() => setSelected(a.id)}>{a.case_id}</button></td><td>{a.attempt}</td>
				<td><pre>{JSON.stringify(batch.suite.cases.find(c => c.id === a.case_id)?.expected, null, 2)}</pre></td>
				<td><pre>{a.result?.parsed ? JSON.stringify(a.result.parsed.answers, null, 2) : '—'}</pre></td>
				<td>{a.result ? a.result.error ? reason[a.result.error] ?? a.result.error : a.result.success ? 'Pass' : 'Incorrect answer' : a.execution_status ?? 'Pending'}</td><td>{percent(a.result?.tool_selection?.accuracy)}</td><td>{seconds(a.latency_ms)}</td>
			</tr>)}</tbody></table></div>
			{attempt && <section aria-label='Evaluation attempt details'><h4>{attempt.case_id} · Attempt {attempt.attempt}</h4>
				<p>{batch.suite.cases.find(c => c.id === attempt.case_id)?.question}</p>
				{attempt.result?.tool_selection && <p>Required tools: {attempt.result.tool_selection.required.join(', ')}. Used: {attempt.result.tool_selection.used.join(', ') || 'None'}. Missing: {attempt.result.tool_selection.missing.join(', ') || 'None'}. Extra: {attempt.result.tool_selection.unexpected.join(', ') || 'None'}.</p>}
				<h4>Final answer</h4><ReadableText text={attempt.result?.parsed?.final_answer ?? attempt.raw_answer ?? 'The answer will appear when the execution finishes.'} />
				{attempt.result?.error && <p role='status'>{reason[attempt.result.error] ?? attempt.result.error}. The original response is retained below.</p>}
				<details><summary>Raw model response and scoring details</summary><pre>{attempt.raw_answer ?? 'No model response.'}</pre><pre>{JSON.stringify(attempt.result, null, 2)}</pre></details>
				{attempt.execution_id && <><p className={styles.help}>Execution {attempt.execution_id} · {attempt.termination_reason}</p><ExecutionTrace key={attempt.execution_id} path={`/${projectId}/executions/${attempt.execution_id}`} version={attempt.result ? 'finished' : attempt.execution_status ?? 'pending'} /><ExecutionArtifacts key={`artifacts-${attempt.execution_id}`} path={`/${projectId}/executions/${attempt.execution_id}`} /></>}
			</section>}
		</>}
	</section>;
}
