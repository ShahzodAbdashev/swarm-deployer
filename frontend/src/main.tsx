import {createRoot} from 'react-dom/client';
import '@devtools/ui';
import './styles/app.css';
import {App} from './App';

createRoot(document.getElementById('root')!).render(<App />);
