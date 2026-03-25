// Firebase Configuration
// 請到 Firebase Console 建立專案後，將 config 貼到這裡
// https://console.firebase.google.com/

const firebaseConfig = {
  apiKey: "AIzaSyB0Y87d2ByEnW43iFg1PZq4KaKVUjO0Yzs",
  authDomain: "claude-dashboard-leaderboard.firebaseapp.com",
  databaseURL: "https://claude-dashboard-leaderboard-default-rtdb.firebaseio.com",
  projectId: "claude-dashboard-leaderboard",
  storageBucket: "claude-dashboard-leaderboard.firebasestorage.app",
  messagingSenderId: "16814808692",
  appId: "1:16814808692:web:43e6bb1a04ed546130bb21"
};

// 設定步驟：
// 1. 前往 https://console.firebase.google.com/
// 2. 建立新專案 (例如: claude-dashboard-leaderboard)
// 3. 在專案設定中找到 "Your apps" > 新增網頁應用程式
// 4. 複製 firebaseConfig 到上方
// 5. 在 Build > Realtime Database 啟用資料庫 (選擇 test mode)
// 6. 在 Build > Authentication > Sign-in method 啟用 "Anonymous"

window.FIREBASE_CONFIG = firebaseConfig;
