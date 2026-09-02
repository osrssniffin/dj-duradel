console.log('Registering Discord commands before container startup...');
await import('./register-commands.js');

console.log('Starting Peak Music Bot...');
await import('../src/index.js');

