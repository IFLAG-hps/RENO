import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../react/src/App.jsx';

vi.mock('../react/src/migrated/main.jsx', () => ({ default: () => null }));
vi.mock('../react/src/migrated/agent.jsx', () => ({ default: () => <div data-testid="agent-page" /> }));
vi.mock('../react/src/migrated/revenue.jsx', () => ({ default: () => <div data-testid="revenue-page" /> }));
vi.mock('../react/src/migrated/mockup.jsx', () => ({ default: () => <div data-testid="mockup-page" /> }));

describe('App route selection', () => {
  afterEach(() => window.history.replaceState({}, '', '/'));

  it.each([
    ['/pages/agent', 'agent-page'],
    ['/pages/revenue.html', 'revenue-page'],
    ['/pages/mockup', 'mockup-page'],
  ])('renders the page for %s', (path, testId) => {
    window.history.replaceState({}, '', path);
    render(<App />);

    expect(screen.getByTestId(testId)).toBeInTheDocument();
  });
});
