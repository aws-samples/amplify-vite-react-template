import { useEffect, useState } from "react";
import type { Schema } from "../amplify/data/resource";
import { generateClient } from "aws-amplify/data";
import { useAuthenticator } from '@aws-amplify/ui-react';

const client = generateClient<Schema>();

function App() {
  const { signOut } = useAuthenticator();
  const [todos, setTodos] = useState<Array<Schema["Todo"]["type"]>>([]);

  useEffect(() => {
    client.models.Todo.observeQuery().subscribe({
      next: (data) => setTodos([...data.items]),
    });
  }, []);

  function createTodo() {
    client.models.Todo.create({ content: window.prompt("Todo content") });
  }

  function deleteTodo(id: string) {
    client.models.Todo.delete({ id })
  }


  return (
    
    <main style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gridTemplateRows: 'auto auto auto auto',
      gap: '20px',
      padding: '20px',
    }}>
      
      <div style={{
        gridColumn: '1 / span 2',
        gridRow: '1',
        backgroundColor: '#f8f8f8',
        padding: '20px',
      }}>
        <h2><center>Q Business Embedding</center></h2>
      </div>

      <div style={{
        gridColumn: '1',
        gridRow: '2',
        backgroundColor: '#f0f0f0',
        padding: '20px',
      }}>
        <h1>Things todo</h1>
      </div>

      <div style={{
        gridColumn: '1',
        gridRow: '3',
        backgroundColor: '#e0e0e0',
        padding: '20px',
      }}>
        
         <button onClick={createTodo} style={{
              padding: '5px 10px',
              fontSize: '14px',
              cursor: 'pointer',
            }}>
              
              + new</button>
        <ul>
          {todos.map((todo) => (
            <li onClick={() => deleteTodo(todo.id)} key={todo.id}>{todo.content}</li>
          ))}
        </ul>
      </div>

      <div style={{
        gridColumn: '2',
        gridRow: '2 / span 2',
        backgroundColor: '#d0d0d0',
        padding: '20px',
        height: '100%',
      }}>
        <h2>Powered Q Business</h2>
        <iframe src="https://eiwbqsqg.chat.qbusiness.us-east-1.on.aws/" width="560" height="100%" title="Q Embeddings"></iframe>
      </div>

      <div style={{
        gridColumn: '1 / span 2',
        gridRow: '4',
        backgroundColor: '#c0c0c0',
        padding: '20px',
      }}>
        <button onClick={signOut}>Sign out</button>
      </div>
    </main>
  );
}

export default App;
