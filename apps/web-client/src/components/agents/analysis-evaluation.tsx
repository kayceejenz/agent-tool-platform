'use client';
import { useEffect, useState } from 'react';
import { Download, Plus } from 'lucide-react';
import type { EvaluationSuite, EvaluationBatch, EvaluationHistory } from '@/types/analysis-evaluation';
import { EvaluationAttemptDetails } from './evaluation-attempt-details';
import { projectRequest, projectWrite } from '@/lib/projects/client';
import { AnalysisDatasetPicker } from './analysis-dataset-picker';
import styles from './analysis-evaluation.module.css';

type Suite = EvaluationSuite;
type Batch = EvaluationBatch;
type History = EvaluationHistory;
const example: Suite = {
    name: 'Dataset checks',
    cases: [{ id: 'COUNT-001', question: 'Count the data rows in records.csv, excluding the header.', expected: { record_count: 100 }, comparison: { record_count: { type: 'exact' } } }],
};
const percent = (n: number | null | undefined) => n == null ? '—' : `${n.toFixed(1)}%`;
const seconds = (n: number | null) => n == null ? '—' : `${(n / 1000).toFixed(2)} s`;
const reason: Record<string, string> = { invalid_answer_format: 'Invalid format', execution_failed: 'Execution failed', access_or_configuration_changed: 'Configuration changed' };

export function AnalysisEvaluation({ projectId, agentId, revision, enabled, canRun }: { projectId: string; agentId: string; revision: number; enabled: boolean; canRun: boolean }) {
	const base = `/${projectId}/agents/${agentId}/analysis-evaluations`;
	const [dataset, setDataset] = useState('');
	const [suite, setSuite] = useState<Suite | null>(null);
	const [repetitions, setRepetitions] = useState<number | ''>(1);
	const [history, setHistory] = useState<History>({ items: [], next_offset: null });
	const [batchId, setBatchId] = useState('');
	const [batch, setBatch] = useState<Batch | null>(null);
	const [selected, setSelected] = useState('');
	const [creating, setCreating] = useState(false);
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
		if (!suite || !dataset || !Number.isInteger(repetitions) || Number(repetitions) < 1 || Number(repetitions) > 100) return;
		setBusy(true); setError('');
		const id = requestId || crypto.randomUUID(); setRequestId(id);
		try {
			const result = await projectWrite<{ id: string }>(base, 'POST', { request_id: id, revision, dataset_id: dataset, attempts: repetitions, suite });
			setBatch(null); setBatchId(result.id); setSelected(''); setCreating(false); setRefresh(n => n + 1); setRequestId('');
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
	function allResults() {
		const id = selected;
		setSelected('');
		requestAnimationFrame(() => document.getElementById(`inspect-${id}`)?.focus());
	}
	if (batch && attempt) {
		const position = batch.attempts.findIndex(item => item.id === selected);
		const question = batch.suite.cases.find(item => item.id === attempt.case_id)!;
		return <section className={styles.root} aria-label='Dataset evaluation'>
			{error && <p role='alert' className='project-error'>{error} <button className='button' onClick={() => { setError(''); setRefresh(n => n + 1); }}>Retry</button></p>}
			<EvaluationAttemptDetails key={attempt.id} attempt={attempt} question={question} projectId={projectId} position={position} total={batch.attempts.length} onBack={allResults} onPrevious={() => setSelected(batch.attempts[position - 1].id)} onNext={() => setSelected(batch.attempts[position + 1].id)} />
		</section>;
	}
	return (
		<section className={styles.root} aria-label='Dataset evaluation'>
			<div className={styles.toolbar}>
				<h3>Evaluations</h3>
				{canRun && batchId && <button className='button' aria-expanded={creating} onClick={() => setCreating(value => !value)}><Plus size={16} aria-hidden='true' /> New evaluation</button>}
			</div>
			{error && <p role='alert' className='project-error'>{error} <button className='button' onClick={() => { setError(''); setRefresh(n => n + 1); }}>Retry</button></p>}
			{canRun && (!batchId || creating) && <form className={styles.form} onSubmit={event => { event.preventDefault(); void start(); }}>
				<AnalysisDatasetPicker projectId={projectId} value={dataset} onChange={value => { setDataset(value); setRequestId(''); }} disabled={busy} showHint={false} />
				<div className={styles.setupFields}>
					<label className='tool-field'>Test suite JSON<input aria-label='Test suite JSON' type='file' accept='.json,application/json' disabled={busy} onChange={event => void upload(event.target.files?.[0])} /></label>
					<label className='tool-field'>Attempts per question<input aria-label='Attempts per question' type='number' min={1} max={100} step={1} required disabled={busy} value={repetitions} onChange={event => { setRepetitions(event.target.value === '' ? '' : Number(event.target.value)); setRequestId(''); }} /></label>
				</div>
				{suite && <p className={styles.meta}>{suite.name} · {suite.cases.length} {suite.cases.length === 1 ? 'question' : 'questions'} · {suite.cases.length * Number(repetitions)} {suite.cases.length * Number(repetitions) === 1 ? 'attempt' : 'attempts'}</p>}
				<div className={styles.controls}>
					<button className='button primary' disabled={busy || !enabled || !dataset || !suite || active}>{busy ? 'Starting…' : 'Run evaluation'}</button>
					<button className='button' type='button' onClick={() => download(example, 'evaluation-suite-example.json')}><Download size={16} aria-hidden='true' /> Example suite</button>
					{creating && <button className='button' type='button' onClick={() => setCreating(false)}>Close</button>}
				</div>
			</form>}
			{!!history.items.length && <div className={styles.history}>
				<label className='tool-field'>Saved evaluations<select aria-label='Saved evaluations' value={batchId} onChange={event => { setBatch(null); setSelected(''); setCreating(false); setBatchId(event.target.value); }}>{history.items.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status}{item.created_at ? ` · ${new Date(item.created_at).toLocaleString()}` : ''}</option>)}</select></label>
				{history.next_offset !== null && <button className='button' onClick={async () => { try { const page = await projectRequest<History>(`${base}?offset=${history.next_offset}`); setHistory(h => ({ items: [...h.items, ...page.items], next_offset: page.next_offset })); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load history.'); } }}>Load older</button>}
			</div>}
			{batchId && !batch && !error && <p role='status'>Loading results…</p>}
			{batch && <>
				<header className={styles.resultHeading}>
					<div><h3>{batch.name}</h3><p className={styles.meta}>{batch.dataset.name} · Revision {batch.agent_revision} · {batch.repetitions} {batch.repetitions === 1 ? 'attempt' : 'attempts'} per question</p></div>
					<div className={styles.controls}>
						{canRun && batch.status === 'running' && <button className='button' disabled={busy} onClick={() => void cancel()}>Cancel evaluation</button>}
						<button className='button' onClick={() => download(batch, `evaluation-${batch.id}.json`)}><Download size={16} aria-hidden='true' /> Export results</button>
					</div>
				</header>
				<div className={styles.progress}>
					<span className={styles.status} data-state={batch.status === 'completed' ? 'correct' : 'pending'}>{batch.status}</span>
					<span role='status'>{batch.summary.finished} of {batch.summary.total} attempts scored</span>
					{active && <progress aria-label='Evaluation progress' value={batch.summary.finished} max={batch.summary.total} />}
				</div>
				<dl className={styles.metrics} aria-label='Evaluation summary'>
					<div><dt>Answer correctness</dt><dd>{percent(batch.summary.answer_correctness)}</dd></div>
					<div><dt>Task success</dt><dd>{percent(batch.summary.task_success_rate)}</dd></div>
					<div><dt title={`Success across all ${batch.repetitions} attempts per question`}>Reliability</dt><dd>{percent(batch.summary.pass_k?.[String(batch.repetitions)])}</dd></div>
					{!!batch.summary.tool_scored_attempts && <div><dt>Tool selection accuracy</dt><dd>{percent(batch.summary.tool_selection_accuracy)}</dd></div>}
					<div><dt>Median latency</dt><dd>{seconds(batch.summary.median_latency_ms)}</dd></div>
					<div><dt>p95 latency</dt><dd>{seconds(batch.summary.p95_latency_ms)}</dd></div>
				</dl>
				<div className={`${styles.table} ${styles.attemptTable}`}>
					<table><caption className={styles.tableCaption}>Attempts</caption><thead><tr><th scope='col'>Question</th><th scope='col'>Attempt</th><th scope='col'>Correctness</th><th scope='col'>Status</th><th scope='col'>Latency</th><th scope='col'>Action</th></tr></thead>
						<tbody>{batch.attempts.map(item => {
							const fields = item.result ? Object.values(item.result.fields) : [];
							const accuracy = fields.length ? 100 * fields.filter(field => field.correct).length / fields.length : null;
							return <tr key={item.id}>
								<td className={styles.questionCell}><strong>{item.case_id}</strong><span title={batch.suite.cases.find(c => c.id === item.case_id)?.question}>{batch.suite.cases.find(c => c.id === item.case_id)?.question}</span></td>
								<td data-label="Attempt">{item.attempt}</td><td data-label="Correctness">{percent(accuracy)}</td>
								<td data-label="Status"><span className={styles.status} data-state={!item.result ? 'pending' : item.result.error ? 'error' : item.result.success ? 'correct' : 'incorrect'}>{item.result ? item.result.error ? reason[item.result.error] ?? item.result.error : item.result.success ? 'Correct' : 'Incorrect' : item.execution_status ?? 'Pending'}</span></td>
								<td data-label="Latency" className={styles.nowrap}>{seconds(item.latency_ms)}</td>
								<td><button id={`inspect-${item.id}`} className='button' aria-label={`Inspect ${item.case_id} attempt ${item.attempt}`} onClick={() => setSelected(item.id)}>Inspect</button></td>
							</tr>;
						})}</tbody>
					</table>
				</div>
			</>}
		</section>
	);
}
