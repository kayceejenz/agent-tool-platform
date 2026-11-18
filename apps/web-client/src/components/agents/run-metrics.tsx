'use client';
import { useEffect, useState } from 'react';
import { projectRequest, projectWrite } from '@/lib/projects/client';
import { MetricInfo } from '@/components/content/metric-info';
import { StructuredPayload } from '@/components/content/structured-payload';
import styles from './run-metrics.module.css';

type Tool = { tool_key: string; name: string; input_schema: Record<string, unknown> };
type Step = Tool & { arguments: Record<string, unknown> };
type Evaluation = {
    state: 'pending' | 'scored' | 'needs_reference'; source: 'question' | 'benchmark';
    tools: Tool[]; expected_steps: Step[] | null; latency_ms: number | null;
    metrics: { precision: number | null; recall: number | null; argument_accuracy: number | null; expected_calls: number; actual_calls: number; matched_calls: number } | null;
};
type Draft = { tool_key: string; arguments: string };
const percent = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(1)}%`;
const definitions = {
    precision: ['Tool precision', 'Matched expected calls divided by all calls made. Each expected step can match once; extra calls reduce precision.'],
    recall: ['Tool recall', 'Matched expected calls divided by saved expected steps. Each actual call can match once.'],
    argument_accuracy: ['Argument accuracy', 'Average matching argument fields among matched calls, using the benchmark calculation. Equivalent defaults match. Python code is compared as text; this does not measure whether different programs produce equivalent results.'],
} as const;

export function RunMetrics({ path, canEdit }: { path: string; canEdit: boolean }) {
    const [data, setData] = useState<Evaluation | null>(null);
    const [error, setError] = useState('');
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const [draft, setDraft] = useState<Draft[]>([]);
    const [verified, setVerified] = useState(false);
    useEffect(() => {
        const controller = new AbortController();
        void projectRequest<Evaluation>(`${path}/metrics`, { signal: controller.signal })
            .then(value => { setData(value); setError(''); })
            .catch(e => { if (!controller.signal.aborted) setError(e.message); });
        return () => controller.abort();
    }, [path, refresh]);
    function pythonCode(value: string) {
        try { return JSON.parse(value).code ?? ''; } catch { return ''; }
    }
    function edit() {
        setDraft(data?.expected_steps?.map(step => ({ tool_key: step.tool_key, arguments: JSON.stringify(step.arguments, null, 2) })) ?? [{ tool_key: data?.tools[0]?.tool_key ?? '', arguments: '{}' }]);
        setVerified(false);
        setEditing(true);
        setError('');
    }
    async function save() {
        if (!verified || saving) return;
        setError('');
        try {
            const steps = draft.map(step => {
                const args = JSON.parse(step.arguments);
                if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Each step needs a JSON object for its arguments.');
                return { tool_key: step.tool_key, arguments: args };
            });
            setSaving(true);
            const result = await projectWrite<Evaluation>(`${path}/metrics`, 'POST', { steps });
            setData(result);
            setEditing(false);
        } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save expected steps.'); }
        finally { setSaving(false); }
    }
    return <section className={styles.panel} aria-label='Run evaluation'>
        <div className={styles.header}>
            <h3>Evaluation</h3>
            {canEdit && data?.source === 'question' && !!data.tools.length && !editing && <button className='button' onClick={edit}>{data.expected_steps ? 'Edit expected steps' : 'Define expected steps'}</button>}
        </div>
        {error && <p className='project-error' role='alert'>{error} {!data && <button className='button' onClick={() => setRefresh(n => n + 1)}>Retry</button>}</p>}
        {!data && !error && <p role='status'>Loading evaluation…</p>}
        {data && <>
            <dl className={styles.metrics}>
                {Object.entries(definitions).map(([key, [label, explanation]]) => <div key={key}>
                    <dt>{label} <MetricInfo label={label} explanation={explanation} /></dt>
                    <dd>{percent(data.metrics?.[key as keyof typeof definitions])}</dd>
                </div>)}
                <div><dt>Latency <MetricInfo label='Latency' explanation='Elapsed execution time from worker start to finish, excluding queue wait.' /></dt><dd>{data.latency_ms === null ? '—' : `${(data.latency_ms / 1000).toFixed(2)} s`}</dd></div>
            </dl>
            {data.state === 'needs_reference' && <p className={styles.help}>Save expected steps for this question to calculate tool-use scores.</p>}
            {data.metrics && <p className={styles.help}>{data.metrics.matched_calls} of {data.metrics.expected_calls} expected calls matched · {data.metrics.actual_calls} calls made. These metrics measure tool use, not final-answer correctness.</p>}
            {data.expected_steps && !editing && <details><summary>Expected steps</summary>
                {data.expected_steps.map((step, i) => <div key={i}><h4>{i + 1}. {step.name}</h4><StructuredPayload value={step.arguments} label={`Expected step ${i + 1} arguments`} /></div>)}
            </details>}
            {editing && <form className={styles.editor} onSubmit={e => { e.preventDefault(); void save(); }}>
                <p className={styles.help}>Define correct calls yourself. Saved steps apply to the same question and dataset contents across agents. Editing them recalculates those scores. Step order is not scored; repeated calls are paired to maximize argument agreement.</p>
                {draft.map((step, i) => <fieldset key={i} disabled={saving}>
                    <legend>Step {i + 1}</legend>
                    <label>Tool<select aria-label={`Step ${i + 1} tool`} value={step.tool_key} required onChange={e => setDraft(items => items.map((item, j) => j === i ? { tool_key: e.target.value, arguments: '{}' } : item))}>
                        {data.tools.map(tool => <option key={tool.tool_key} value={tool.tool_key}>{tool.name}</option>)}
                    </select></label>
                    <label>{step.tool_key === 'workspace_execute_python' ? 'Expected Python code' : 'Expected arguments'}<textarea aria-label={`Step ${i + 1} expected arguments`} rows={5} value={step.tool_key === 'workspace_execute_python' ? pythonCode(step.arguments) : step.arguments} required maxLength={70000} spellCheck={false} onChange={e => setDraft(items => items.map((item, j) => j === i ? { ...item, arguments: step.tool_key === 'workspace_execute_python' ? JSON.stringify({ code: e.target.value }) : e.target.value } : item))} /></label>
                    <details><summary>Tool schema</summary><StructuredPayload value={data.tools.find(tool => tool.tool_key === step.tool_key)?.input_schema} label={`Step ${i + 1} schema`} /></details>
                    {draft.length > 1 && <button className='button destructive' type='button' onClick={() => setDraft(items => items.filter((_, j) => i !== j))}>Remove step {i + 1}</button>}
                </fieldset>)}
                <button className='button' type='button' disabled={saving || draft.length >= 50} onClick={() => setDraft(items => [...items, { tool_key: data.tools[0].tool_key, arguments: '{}' }])}>Add step</button>
                <label className={styles.verify}><input type='checkbox' checked={verified} onChange={e => setVerified(e.target.checked)} required disabled={saving} />I verified these expected calls answer the question.</label>
                <div className={styles.actions}><button type='button' className='button' disabled={saving} onClick={() => setEditing(false)}>Cancel</button><button className='button primary' disabled={saving || !verified}>{saving ? 'Saving…' : 'Save expected steps'}</button></div>
            </form>}
        </>}
    </section>;
}
