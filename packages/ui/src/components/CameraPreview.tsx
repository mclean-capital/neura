interface CameraPreviewProps {
  isActive: boolean;
  setVideoElement: (el: HTMLVideoElement | null) => void;
}

export function CameraPreview({ isActive, setVideoElement }: CameraPreviewProps) {
  if (!isActive) return null;

  return (
    <div className="preview-container">
      <video ref={setVideoElement} autoPlay playsInline muted className="preview-video" />
      <span className="preview-label">Camera</span>
    </div>
  );
}
