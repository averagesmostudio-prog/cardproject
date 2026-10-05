// Shown on iPhone, where Safari can't full-screen a web page from a button.
export default function FullscreenHint({ open, onClose }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-3" onClick={onClose}>
      <div
        className="max-w-md w-full bg-stone-900 border border-stone-600 rounded-lg p-4 text-stone-200 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-semibold text-base mb-2">Full screen on iPhone</div>
        <p className="mb-2">
          Safari doesn't let websites hide the address bar. To play without it, install the game to your Home Screen:
        </p>
        <ol className="list-decimal pl-5 space-y-1 mb-3">
          <li>Tap the Share button in Safari.</li>
          <li>Choose <b>Add to Home Screen</b>.</li>
          <li>Open Scripturas from the new icon.</li>
        </ol>
        <button onClick={onClose} className="px-3 py-1.5 rounded border border-stone-600 hover:border-stone-400 text-stone-200">Got it</button>
      </div>
    </div>
  );
}
