export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <img
      className={`brand-mark ${className}`.trim()}
      src="/brand/quota-mark.png"
      width={44}
      height={40}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
