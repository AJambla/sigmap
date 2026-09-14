// Go fixture
package main

type UserService struct {
	repo Repository
}

type Repository interface {
	FindById(id string) (*User, error)
	Save(user *User) error
}

func NewUserService(repo Repository) *UserService {
	return &UserService{repo: repo}
}

func (s *UserService) GetUser(id string) (*User, error) {
	return s.repo.FindById(id)
}

func (s *UserService) CreateUser(data CreateUserDto) (*User, error) {
	user := &User{ID: data.ID}
	return user, s.repo.Save(user)
}

func HashPassword(password string) (string, error) {
	return password, nil
}

// Apply maps f over n.
func Apply(f func(int) error, n int) error {
	return f(n)
}

func Map[T, U any](s []T, f func(T) U) []U {
	out := make([]U, len(s))
	return out
}

type Stack[T any] struct {
	items []T
}

func (s *Stack[T]) Push(v T) {
	s.items = append(s.items, v)
}

func Fetch(url string) string {
	base := "https://example.com" // trailing comment
	return base + url
}

func Join(
	parts []string,
	sep string,
) string {
	return sep
}

func Sum(nums ...int) int {
	return 0
}

type Runner interface {
	Run(handler func(ctx string) error) (int, error)
}
