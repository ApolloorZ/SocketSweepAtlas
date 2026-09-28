/**
 * The one and only slider switch.
 *
 * Two things here are deliberate. The knob is centred by flex layout rather than
 * `top: 50%` plus a `translateY(-50%)` correction, and the knob is exactly as
 * tall as the track: any vertical slack at all gets rounded to whole device
 * pixels per row, which made identical switches read high in one row and low in
 * the next. The knob's own outline is symmetric for the same reason — a
 * downward drop shadow makes a centred circle look like it sits too high.
 */
export function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      title={label}
      aria-label={label}
      className="flex items-center shrink-0 w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer"
      style={{
        background: on ? "var(--color-accent-500)" : "var(--toggle-off)",
        boxShadow: on ? "none" : "inset 0 0 0 1px var(--toggle-off-edge)",
      }}
    >
      <span
        className="w-6 h-6 rounded-full bg-white transition-transform duration-200 ease-out"
        style={{
          transform: on ? "translateX(20px)" : "translateX(0)",
          boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.07), 0 0 3px rgba(0, 0, 0, 0.22)",
        }}
      />
    </button>
  );
}
