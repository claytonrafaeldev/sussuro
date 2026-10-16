import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Overlay } from './Overlay';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Elemento principal da interface não encontrado.');
const overlay = !!window.sussurroOverlay;
if (overlay) document.documentElement.classList.add('overlay-document');
createRoot(root).render(<React.StrictMode>{overlay ? <Overlay /> : <App />}</React.StrictMode>);
