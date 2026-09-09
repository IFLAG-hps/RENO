import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import DesktopQrDock from '../react/src/DesktopQrDock.jsx';

describe('DesktopQrDock', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app" style="display: flex"></div>';
    localStorage.clear();
  });

  it('renders the QR image while the app is visible', async () => {
    render(<DesktopQrDock />);

    const dock = await screen.findByRole('complementary');
    const image = await screen.findByRole('img');

    expect(dock).toBeInTheDocument();
    expect(image).toHaveAttribute('src', expect.stringContaining('api.qrserver.com'));
  });

  it('restores a saved position and persists a dragged position', async () => {
    localStorage.setItem('reno-desktop-qr-position', JSON.stringify({ left: 40, top: 60 }));
    render(<DesktopQrDock />);
    await screen.findByRole('complementary');
    const handle = document.querySelector('.desktop-qr-dock-drag-handle');
    const dock = screen.getByRole('complementary');

    expect(dock).toHaveStyle({ left: '40px', top: '60px' });
    Object.defineProperty(dock, 'offsetWidth', { value: 100, configurable: true });
    Object.defineProperty(dock, 'offsetHeight', { value: 80, configurable: true });
    fireEvent.pointerDown(handle, { clientX: 40, clientY: 60, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 80, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    await waitFor(() => expect(JSON.parse(localStorage.getItem('reno-desktop-qr-position'))).toEqual({ left: 40, top: 40 }));
  });

  it('does not render while the app is hidden', () => {
    document.getElementById('app').style.display = 'none';
    render(<DesktopQrDock />);

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });
});
