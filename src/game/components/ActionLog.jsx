import React, { useEffect, useRef } from 'react';

export default function ActionLog({ entries }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries]);

  return (
    <div ref={ref} className="bg-white border border-stone-200 rounded-lg p-3 h-40 overflow-y-auto text-xs space-y-1">
      {entries.map((entry, i) => (
        <div key={i} className="text-stone-600">
          {entry.player && <span className="font-semibold text-stone-800">[{entry.player}] </span>}
          {entry.message}
        </div>
      ))}
    </div>
  );
}
