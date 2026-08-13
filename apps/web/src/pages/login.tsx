import type { AuthSession } from "@cocean/contracts";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { BrandLockup, Button } from "../components.js";

export function LoginPage({
  onLogin,
}: {
  onLogin: (session: AuthSession) => void;
}) {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="login-page">
      <section className="login-brand-panel">
        <BrandLockup />
        <div>
          <p className="eyebrow">PRIVATE HIFI LIBRARY</p>
          <h1>
            你的唱片，
            <br />
            留在自己的 NAS。
          </h1>
          <p>本地刮削、Still 推荐、试听核验与播放器投送。</p>
        </div>
        <small>COCEAN · Still v0.10 design language</small>
      </section>
      <section className="login-form-panel">
        <form
          action="/api/v1/auth/login"
          method="post"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitting(true);
            setError(null);
            void api
              .login(username, password)
              .then((session) => {
                onLogin(session);
                navigate("/", { replace: true });
              })
              .catch((reason) =>
                setError(reason instanceof Error ? reason.message : "登录失败"),
              )
              .finally(() => setSubmitting(false));
          }}
        >
          <span className="login-lock">
            <LockKeyhole />
          </span>
          <div>
            <p className="eyebrow">SIGN IN</p>
            <h2>登录 COCEAN</h2>
            <p>账号保存在本地 NAS，可由管理员添加多人使用。</p>
          </div>
          <label>
            <span>账号</span>
            <input
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </label>
          <label>
            <span>密码</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error ? (
            <p className="login-error" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={submitting}>
            {submitting ? "正在登录" : "登录"} <ArrowRight />
          </Button>
          <small>浏览器可保存此账号与密码；服务端只保存加盐哈希。</small>
        </form>
      </section>
    </main>
  );
}
