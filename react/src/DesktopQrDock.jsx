import { useEffect, useRef, useState } from 'react';

const POSITION_KEY = 'reno-desktop-qr-position';
const DEFAULT_POSITION = { right: 8, bottom: 14 };

export default function DesktopQrDock() {
  const [qrImageSrc, setQrImageSrc] = useState('');
  const [isAppVisible, setIsAppVisible] = useState(false);
  const [position, setPosition] = useState(DEFAULT_POSITION);
  const dragRef = useRef(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        setPosition({ left: saved.left, top: saved.top });
      }
    } catch { /* 保存データが壊れていても初期位置で表示する */ }

    const modalQrImage = document.querySelector('#qrModal .qr-img-wrap img');
    if (modalQrImage) setQrImageSrc(modalQrImage.currentSrc || modalQrImage.src);

    const app = document.getElementById('app');
    if (!app) return undefined;

    const updateVisibility = () => {
      setIsAppVisible(getComputedStyle(app).display !== 'none');
    };
    updateVisibility();

    const observer = new MutationObserver(updateVisibility);
    observer.observe(app, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => observer.disconnect();
  }, []);

  const handlePointerDown = (event) => {
    const dock = event.currentTarget.closest('#desktopQrDock');
    if (!dock) return;
    const rect = dock.getBoundingClientRect();
    dragRef.current = { startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dock = event.currentTarget.closest('#desktopQrDock');
    const maxLeft = Math.max(0, window.innerWidth - dock.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - dock.offsetHeight);
    const left = Math.min(maxLeft, Math.max(0, drag.left + event.clientX - drag.startX));
    const top = Math.min(maxTop, Math.max(0, drag.top + event.clientY - drag.startY));
    setPosition({ left, top });
  };

  const handlePointerUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setPosition((current) => {
      try { localStorage.setItem(POSITION_KEY, JSON.stringify(current)); } catch { /* ignore */ }
      return current;
    });
  };

  if (!isAppVisible) return null;

  return (
    <aside
      id="desktopQrDock"
      aria-label="スマホで開くためのQRコード"
      style={position.left != null ? { left: `${position.left}px`, top: `${position.top}px` } : { right: `${position.right}px`, bottom: `${position.bottom}px` }}
    >
      <div className="desktop-qr-dock-icon" aria-hidden="true">⌘</div>
      <div
        className="desktop-qr-dock-title desktop-qr-dock-drag-handle"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        title="ドラッグして移動"
      >スマホで開く</div>
      <p>カメラで読み取ると<br />すぐに開けます</p>
      {qrImageSrc && <img src={qrImageSrc} alt="スマホで開くためのQRコード" />}
    </aside>
  );
}
