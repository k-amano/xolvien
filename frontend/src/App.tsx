import { Routes, Route } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import TaskCreate from './pages/TaskCreate'
import TaskDetail from './pages/TaskDetail'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/tasks/new" element={<TaskCreate />} />
      <Route path="/tasks/:id" element={<TaskDetail />} />
    </Routes>
  )
}
