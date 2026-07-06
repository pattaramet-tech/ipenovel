import db from './server/db.ts';
const episodes = await db.getAllEpisodes();
console.log(JSON.stringify(episodes.slice(0, 3), null, 2));
