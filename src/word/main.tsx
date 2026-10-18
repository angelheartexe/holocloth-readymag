import { createRoot } from 'react-dom/client';
import './theme.ts';
import WordApp from './WordApp.tsx';

createRoot(document.getElementById('root')!).render(<WordApp />);
