interface ScreenPreviewProps {
  isActive: boolean;
  setVideoElement: (el: HTMLVideoElement | null) => void;
}

export function ScreenPreview({ isActive, setVideoElement }: ScreenPreviewProps) {
  if (!isActive) return null;

  return (
    <div className="preview-container">
      <video ref={setVideoElement} autoPlay playsInline muted className="preview-video" />
      <span className="preview-label">Screen</span>
    </div>
  );
}
