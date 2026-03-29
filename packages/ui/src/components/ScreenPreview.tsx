interface ScreenPreviewProps {
  isActive: boolean;
  setVideoElement: (el: HTMLVideoElement | null) => void;
}

export function ScreenPreview({ isActive, setVideoElement }: ScreenPreviewProps) {
  if (!isActive) return null;

  return (
    <div className="relative w-55 h-[165px] rounded-xl overflow-hidden border-2 border-accent bg-dark-surface">
      <video
        ref={setVideoElement}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-cover"
      />
      <span className="absolute bottom-1.5 left-2 text-[0.65rem] font-semibold bg-black/60 px-1.5 py-0.5 rounded text-accent">
        Screen
      </span>
    </div>
  );
}
