// Entry point for the bundled, single-file web player.
import { startPlayer } from './player.js';
import { loadFonts } from './data/fonts.js';

startPlayer({ audioSrc: window.__AUDIO_SRC || 'score.mp3', loadFonts });
