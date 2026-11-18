'use client';
import { useId, useState } from 'react';
import { Info } from 'lucide-react';

export function MetricInfo({
	label,
	explanation,
}: {
	label: string;
	explanation: string;
}) {
	const id = useId();
	const [open, setOpen] = useState(false);
	return (
		<span
			className='metric-info'
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={event =>
				setOpen(
					event.currentTarget.contains(
						document.activeElement,
					),
				)
			}>
			<button
				type='button'
				className='metric-info-button'
				aria-label={`About ${label.toLowerCase()}`}
				aria-describedby={open ? id : undefined}
				onFocus={() => setOpen(true)}
				onBlur={() => setOpen(false)}
				onClick={() => setOpen(true)}
				onKeyDown={event => {
					if (event.key === 'Escape') {
						setOpen(false);
						event.stopPropagation();
					}
				}}>
				<Info size={16} aria-hidden='true' />
			</button>
			{open && (
				<span
					id={id}
					role='tooltip'
					className='metric-info-tooltip'>
					{explanation}
				</span>
			)}
		</span>
	);
}
