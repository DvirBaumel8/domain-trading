// Public entry of the visits module (v5.18.0, CR-068): the $0 visitor counter. Sits above registrars and listing (the URL forward, the lander nameservers); only app.ts imports it.
export { registerVisits } from './api/visits.js';
