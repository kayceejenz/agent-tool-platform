'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import type { EvaluationAttempt, EvaluationCase } from '@/types/analysis-evaluation';
import { ReadableText } from '@/components/content/readable-text';
import { ExecutionArtifacts } from './execution-artifacts';
import { ExecutionTrace } from './execution-trace';
import styles from './analysis-evaluation.module.css';

export function EvaluationAttemptDetails({
	attempt, question, projectId, position, total, onBack, onPrevious, onNext,
}: {
	attempt: EvaluationAttempt;
	question: EvaluationCase;
	projectId: string;
	position: number;
	total: number;
	onBack: () => void;
	onPrevious: () => void;
	onNext: () => void;
}) {
	const heading = useRef<HTMLHeadingElement>(null);
	const [traceOpen, setTraceOpen] = useState(false);
	useEffect(() => { heading.current?.focus(); }, [attempt.id]);
	const fields = attempt.result ? Object.values(attempt.result.fields) : [];
	const accuracy = fields.length ? 100 * fields.filter(field => field.correct).length / fields.length : null;
	const selection = attempt.result?.tool_selection;
	const state = !attempt.result ? 'pending' : attempt.result.error ? 'error' : attempt.result.success ? 'correct' : 'incorrect';
	const status = !attempt.result ? attempt.execution_status ?? 'Pending' : attempt.result.error === 'invalid_answer_format' ? 'Invalid format' : attempt.result.error ? 'Failed' : attempt.result.success ? 'Correct' : 'Incorrect';
	const path = `/${projectId}/executions/${attempt.execution_id}`;
	return (
		<section className={styles.inspector} aria-label='Evaluation attempt details'>
			<div className={styles.toolbar}>
				<button className='button' onClick={onBack}><ArrowLeft size={16} aria-hidden='true' /> All results</button>
				<div className={styles.pager}>
					<span>{position + 1} of {total}</span>
					<button className='button' aria-label='Previous attempt' disabled={position === 0} onClick={onPrevious}><ChevronLeft size={16} aria-hidden='true' /></button>
					<button className='button' aria-label='Next attempt' disabled={position === total - 1} onClick={onNext}><ChevronRight size={16} aria-hidden='true' /></button>
				</div>
			</div>
			<header className={styles.detailHeading}>
				<div><h3 ref={heading} tabIndex={-1}>{attempt.case_id}</h3><p className={styles.meta}>Attempt {attempt.attempt}</p></div>
				<span className={styles.status} data-state={state}>{status}</span>
			</header>
			<dl className={styles.metrics}>
				<div><dt>Answer correctness</dt><dd>{accuracy === null ? '—' : `${accuracy.toFixed(1)}%`}</dd></div>
				<div><dt>Task success</dt><dd>{attempt.result ? attempt.result.success ? '100%' : '0%' : '—'}</dd></div>
				{selection && <div><dt>Tool selection accuracy</dt><dd>{selection.accuracy.toFixed(1)}%</dd></div>}
				<div><dt>Latency</dt><dd>{attempt.latency_ms === null ? '—' : `${(attempt.latency_ms / 1000).toFixed(2)} s`}</dd></div>
			</dl>
			<section className={styles.question} aria-label='Evaluation question'><h4>Question</h4><p>{question.question}</p></section>
			<section className={styles.answer} aria-label='Agent answer'>
				<h4>Final answer</h4>
				<ReadableText text={attempt.result?.parsed?.final_answer ?? attempt.raw_answer ?? 'Waiting for the agent’s answer…'} />
				{attempt.result?.error && <p className={styles.failure} role='status'>{attempt.result.error === 'invalid_answer_format' ? 'Invalid evaluation format. Original answer shown above.' : 'The execution did not complete successfully.'}</p>}
			</section>
			<section aria-label='Answer comparison'>
				<h4>Answer comparison</h4>
				<div className={styles.comparisons}>
					{Object.entries(question.expected).map(([key, expected]) => {
						const field = attempt.result?.fields[key];
						return <article className={styles.comparison} key={key}>
							<header><h5>{key}</h5><span className={styles.status} data-state={!attempt.result ? 'pending' : field?.correct ? 'correct' : 'incorrect'}>{!attempt.result ? 'Pending' : field?.correct ? 'Matched' : 'Not matched'}</span></header>
							<div className={styles.values}>
								<div><span>Expected</span><pre>{JSON.stringify(expected, null, 2)}</pre></div>
								<div><span>Actual</span><pre>{field?.present ? JSON.stringify(field.actual, null, 2) : attempt.result ? 'Missing' : 'Pending'}</pre></div>
							</div>
						</article>;
					})}
				</div>
			</section>
			{selection && <section aria-label='Tool selection comparison'><h4>Tool selection</h4><dl className={styles.toolLists}>
				<div><dt>Required</dt><dd>{selection.required.map(tool => <code key={tool}>{tool}</code>)}</dd></div>
				<div><dt>Used</dt><dd>{selection.used.length ? selection.used.map(tool => <code key={tool}>{tool}</code>) : 'None'}</dd></div>
				{!!selection.missing.length && <div><dt>Missing</dt><dd>{selection.missing.map(tool => <code key={tool}>{tool}</code>)}</dd></div>}
				{!!selection.unexpected.length && <div><dt>Extra</dt><dd>{selection.unexpected.map(tool => <code key={tool}>{tool}</code>)}</dd></div>}
			</dl></section>}
			<section className={styles.evidence} aria-label='Execution evidence'>
				<h4>Evidence</h4>
				{attempt.execution_id && <>
					<details onToggle={event => setTraceOpen(event.currentTarget.open)}><summary>Execution trace</summary>{traceOpen && <ExecutionTrace path={path} version={attempt.result ? 'finished' : attempt.execution_status ?? 'pending'} formatted />}</details>
					<details><summary>Generated files</summary><ExecutionArtifacts path={path} /></details>
				</>}
				<details><summary>Raw response</summary><pre>{attempt.raw_answer ?? 'No response yet.'}</pre></details>
				<details><summary>Scoring details</summary><pre>{attempt.result ? JSON.stringify(attempt.result, null, 2) : 'Scoring pending.'}</pre></details>
				{attempt.execution_id && <p className={styles.executionId}>Execution {attempt.execution_id}</p>}
			</section>
		</section>
	);
}
