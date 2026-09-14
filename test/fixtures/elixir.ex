defmodule MyApp.Accounts do
  @moduledoc """
  The Accounts context. Owns users and credentials.
  """

  import Ecto.Query, warn: false
  alias MyApp.Repo
  alias MyApp.Accounts.User

  @doc """
  Gets a single user by id. Raises `Ecto.NoResultsError` if missing.
  """
  @spec get_user!(integer()) :: User.t()
  def get_user!(id), do: Repo.get!(User, id)

  @doc "Lists all users, newest first."
  @spec list_users() :: [User.t()]
  def list_users do
    Repo.all(from u in User, order_by: [desc: u.inserted_at])
  end

  @doc "Creates a user from attrs."
  def create_user(attrs \\ %{}) do
    %User{}
    |> User.changeset(attrs)
    |> Repo.insert()
  end

  def update_user(%User{} = user, attrs) when is_map(attrs) do
    user
    |> User.changeset(attrs)
    |> Repo.update()
  end

  defp normalize_email(email) do
    String.downcase(String.trim(email))
  end

  defmacro __using__(_opts) do
    quote do
      import MyApp.Accounts
    end
  end

  defp _internal_probe(x), do: x
end
