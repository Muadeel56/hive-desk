import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppLayout } from './layout/AppLayout';
import { RequireAuth } from './auth/RequireAuth';
import { Login } from './pages/Login';
import { ConversationsView, SelectConversationPrompt } from './pages/ConversationsView';
import { ConversationDetail } from './pages/ConversationDetail';
import { Settings } from './pages/Settings';

export const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      {
        path: '',
        element: <ConversationsView />,
        children: [
          { index: true, element: <SelectConversationPrompt /> },
          { path: 'conversations/:id', element: <ConversationDetail /> },
        ],
      },
      { path: 'settings', element: <Settings /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
