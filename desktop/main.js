// Retro Free Kick for Windows: the same game as the browser version, in its own window.
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 450, height: 800, minWidth: 270, minHeight: 480, // the game is 9:16; it letterboxes at any size
    title: 'Retro Free Kick', backgroundColor: '#000000', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { autoplayPolicy: 'no-user-gesture-required' }, // title music from launch, like the Android app
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html')); // F11 toggles fullscreen (Electron's default menu)
});
app.on('window-all-closed', () => app.quit());
