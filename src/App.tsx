import { useEffect, useState } from "react";
import type { Schema } from "../amplify/data/resource";
import { generateClient } from "aws-amplify/data";
import NavBar from "./components/NavBar/NavBar.tsx";
import SideNav from "./components/SideNav/SideNav.tsx";

// const client = generateClient<Schema>();

function App() {
  const [todos, setTodos] = useState<Array<Schema["Todo"]["type"]>>([]);

  useEffect(() => {
    // client.models.Todo.observeQuery().subscribe({
    //   next: (data) => setTodos([...data.items]),
    // });
  }, []);

  function createTodo() {
    // client.models.Todo.create({ content: window.prompt("Todo content") });
  }


  
  return (
    <>
    <NavBar />
    <SideNav />
      <div className="app-shell">
        <main>
      <h1>My todos</h1>
      <button onClick={createTodo}>+ new</button>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>{todo.content}</li>
        ))}
      </ul>
      <div>
        🥳 App successfully hosted. Try creating a new todo.
        <br />
        <a href="https://docs.amplify.aws/react/start/quickstart/#make-frontend-updates">
          Review next step of this tutorial.
        </a>
      </div>
    </main>
    </div>
    </>
  );
}

export default App;
